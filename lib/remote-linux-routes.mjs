import crypto from 'node:crypto';
import path from 'node:path';

// Block 18: the HTTP routes for SSH hosts and the servers on them. All routes are local-only API routes behind
// requirePermission; none is offered to the phone gateway. Answers carry fixed codes, never the text of an error
// from a lower layer, and never a key, a passphrase or log text outside the log route.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const PUBLIC_CODE = /^(?:REMOTE_[A-Z0-9_]+|VAULT_[A-Z0-9_]+|CREDENTIAL_[A-Z0-9_]+|RCON_[A-Z0-9_]+|B3_[A-Z0-9_]+|INSTANCE_(?:CONFIG_INVALID|NETWORK_INVALID|NETWORK_CONFIRMATION_REQUIRED|PROCESS_IDENTITY_BLOCKED)|RUNTIME_ROOT_BLOCKED|RECOVERY_REQUIRED)$/;
const CONFLICT = /DOCKER_(?:NOT_CONFIRMED|IMAGE_MISSING|MODE_CHANGED)|EXISTS|BUSY|CONFLICT|IN_USE|RUNNING|ALREADY|RECOVERY_BLOCKED|RECOVERY_REQUIRED|HOST_KEY_(?:CHANGED|MISMATCH|UNVERIFIED)|PORT_CONFLICT|PATH_OVERLAP|CONFIRMATION_REQUIRED/;
const HEX64 = /^[0-9a-f]{64}$/;

function exact(body, required, optional = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('REMOTE_ARGUMENT_INVALID');
  const keys = Object.keys(body);
  if (required.some(key => !(key in body)) || keys.some(key => !required.includes(key) && !optional.includes(key))) fail('REMOTE_ARGUMENT_INVALID');
  return body;
}
// Block 19: a container ID leaves the server shortened, as `docker ps` shows it.
const brief = entry => (typeof entry?.runtime?.containerId === 'string' ? { ...entry, runtime: { ...entry.runtime, containerId: entry.runtime.containerId.slice(0, 12) } } : entry);

export function registerRemoteLinuxRoutes({ app, requirePermission, audit, hostService, hostStore, manager, credentials, rcon = null, hasPermission = () => false, remoteCredentials = null, b3 = null, sessionPool = null }) {
  const route = (action, status = 200) => async (req, res) => {
    const correlationId = crypto.randomUUID();
    const details = { correlationId, method: req.method, route: req.route.path, actor: req.auth.username, remoteId: req.params.id || null };
    try {
      const result = await action(req);
      audit('info', 'remote.operation', details);
      res.status(status).json({ ok: true, correlationId, ...result });
    } catch (error) {
      const code = PUBLIC_CODE.test(error.code || '') ? error.code : 'REMOTE_OPERATION_FAILED';
      audit('warn', 'remote.operation.blocked', { ...details, code });
      const statusCode = /NOT_FOUND$/.test(code) ? 404 : code === 'VAULT_LOCKED' ? 423 : code === 'RCON_COMMAND_BLOCKED' ? 403 : /^RCON_(?:TIMEOUT|SOCKET_FAILED|UNREACHABLE)$/.test(code) ? 504 : CONFLICT.test(code) ? 409 : 400;
      res.status(statusCode).json({
        ok: false, correlationId, code, error: code,
        ...(error.rcon && typeof error.rcon === 'object' ? { rcon: error.rcon } : {}),
        ...(Array.isArray(error.reasons) ? { reasons: error.reasons.map(reason => ({ code: reason.code })) } : {}),
        ...(HEX64.test(error.presentedSha256 || '') ? { presentedSha256: error.presentedSha256 } : {}),
        ...(HEX64.test(error.pinnedSha256 || '') ? { pinnedSha256: error.pinnedSha256 } : {}),
        // what `docker build` printed, already bounded and redacted by the host service
        ...(code === 'REMOTE_DOCKER_BUILD_FAILED' && typeof error.output === 'string' ? { output: error.output.slice(0, 4096) } : {}),
      });
    } finally {
      // key material is not kept around in the request object
      if (req.body && typeof req.body === 'object') { delete req.body.privateKey; delete req.body.passphrase; }
    }
  };
  const get = (path, permission, action) => app.get(path, requirePermission(permission), route(action));
  const post = (path, permission, action, status) => app.post(path, requirePermission(permission), route(action, status));

  // ---- hosts ------------------------------------------------------------------------------------------------
  get('/api/remote-hosts', 'diagnostics.read', async () => ({ hosts: hostStore.list() }));
  post('/api/remote-hosts', 'server.manage', async req => ({ host: await hostService.createHost(exact(req.body, ['id', 'label', 'host', 'port', 'username'])) }), 201);
  app.delete('/api/remote-hosts/:id', requirePermission('server.manage'), route(async req => { await hostService.removeHost(req.params.id); return {}; }));
  post('/api/remote-hosts/:id/hostkey/probe', 'server.manage', async req => ({ fingerprint: await hostService.probeHostKey(req.params.id) }));
  post('/api/remote-hosts/:id/hostkey/trust', 'server.manage', async req => ({ host: await hostService.trustHostKey(req.params.id, exact(req.body, ['expectedSha256']).expectedSha256) }));

  // ---- Docker on a host (Block 19): what the host shows, the confirmation of how Docker is reached, the image
  get('/api/remote-hosts/:id/docker', 'diagnostics.read', async req => ({ docker: await hostService.dockerStatus(req.params.id) }));
  post('/api/remote-hosts/:id/docker/confirm', 'server.manage', async req => ({ host: await hostService.confirmDocker(req.params.id, { confirm: exact(req.body, ['confirm']).confirm }) }));
  app.delete('/api/remote-hosts/:id/docker/confirm', requirePermission('server.manage'), route(async req => ({ host: await hostService.withdrawDocker(req.params.id) })));
  post('/api/remote-hosts/:id/docker/image', 'server.manage', async req => { exact(req.body, []); return { image: await hostService.buildDockerImage(req.params.id) }; });

  // ---- the SSH key of a host (the vault subject is ssh_<hostId>) -----------------------------------------------
  get('/api/remote-hosts/:id/credentials', 'config.manage', async req => {
    hostStore.get(req.params.id);
    return { credentials: await credentials.instanceStatus(hostService.subject(req.params.id)) };
  });
  post('/api/remote-hosts/:id/credentials/ssh', 'config.manage', async req => {
    const body = exact(req.body, ['expectedSha256', 'privateKey'], ['passphrase']);
    hostStore.get(req.params.id);
    const value = JSON.stringify({ privateKey: body.privateKey, ...(body.passphrase === undefined ? {} : { passphrase: body.passphrase }) });
    const credential = await credentials.set(hostService.subject(req.params.id), 'ssh', { value, expectedSha256: body.expectedSha256 });
    sessionPool?.drop(req.params.id); // A4-6: the next use logs in with the new key
    return { credential };
  });
  post('/api/remote-hosts/:id/credentials/ssh/remove', 'config.manage', async req => {
    hostStore.get(req.params.id);
    const credential = await credentials.remove(hostService.subject(req.params.id), 'ssh', { expectedSha256: exact(req.body, ['expectedSha256']).expectedSha256 });
    sessionPool?.drop(req.params.id); // A4-6: no session outlives its key
    return { credential };
  });

  // 4.18.25: a core file is named inside the import directory of CONTROL; a relative name is completed here,
  // and the manager refuses whatever does not lie in that directory.
  const withCore = body => (typeof body.corePath === 'string' && body.corePath && !path.isAbsolute(body.corePath) && manager.coreImportRoot ? { ...body, corePath: path.join(manager.coreImportRoot, body.corePath) } : body);

  // ---- instances ----------------------------------------------------------------------------------------------
  get('/api/remote-instances', 'diagnostics.read', async () => ({ instances: (await manager.statusAll()).map(brief), coreImportRoot: manager.coreImportRoot ?? null }));
  post('/api/remote-instances', 'install.execute', async req => ({ instance: await manager.install(withCore(exact(req.body, ['id', 'name', 'hostId', 'port', 'remoteRoot', 'basePath', 'corePath', 'coreVersion', 'expectedCoreSha256'], ['deployment']))) }), 201);
  get('/api/remote-instances/:id', 'diagnostics.read', async req => ({ status: brief(await manager.status(req.params.id)) }));
  post('/api/remote-instances/:id/update', 'update.execute', async req => {
    const { restorePointId = null, ...instance } = await manager.updateCore(req.params.id, withCore(exact(req.body, ['corePath', 'coreVersion', 'expectedCoreSha256'])));
    return { instance, restorePointId };
  });
  // Block 21: puts the kept core back (also the way out of RECOVERY_REQUIRED after a failed update).
  post('/api/remote-instances/:id/core/rollback', 'update.execute', async req => { exact(req.body ?? {}, []); return manager.rollbackCore(req.params.id); });
  for (const operation of ['start', 'stop', 'restart', 'recover']) post(`/api/remote-instances/:id/${operation}`, 'server.manage', async req => ({ status: brief(await manager[operation](req.params.id)) }));
  post('/api/remote-instances/:id/deployment', 'server.manage', async req => manager.setDeployment(req.params.id, exact(req.body, ['deployment'])));
  post('/api/remote-instances/:id/network', 'server.manage', async req => ({ network: await manager.changeNetwork(req.params.id, req.body) }));
  get('/api/remote-instances/:id/health', 'diagnostics.read', async req => ({ health: await manager.health(req.params.id) }));
  get('/api/remote-instances/:id/logs', 'diagnostics.read', async req => ({ logs: await manager.logs(req.params.id, req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }) }));
  get('/api/remote-instances/:id/config', 'config.manage', async req => ({ configuration: await manager.readConfig(req.params.id) }));
  app.put('/api/remote-instances/:id/config', requirePermission('config.manage'), route(async req => ({ configuration: await manager.writeConfig(req.params.id, exact(req.body, ['text', 'expectedSha256'])) })));
  get('/api/remote-instances/:id/backups', 'config.manage', async req => ({ backups: await manager.listBackups(req.params.id) }));
  post('/api/remote-instances/:id/backups', 'config.manage', async req => ({ backup: await manager.createBackup(req.params.id) }), 201);
  post('/api/remote-instances/:id/backups/:backupId/restore', 'config.manage', async req => ({ restored: await manager.restoreBackup(req.params.id, req.params.backupId) }));

  // ---- RCON (Block 18b): the same shapes and permissions as /api/instances/:id/rcon; the remote id is checked first.
  if (rcon) {
    const known = id => manager.instances.get(id); // REMOTE_INSTANCE_NOT_FOUND
    get('/api/remote-instances/:id/rcon', 'server.manage', async req => { known(req.params.id); return { rcon: rcon.status(req.params.id) }; });
    get('/api/remote-instances/:id/rcon/online', 'diagnostics.read', async req => { known(req.params.id); return { online: await rcon.online(req.params.id, { full: hasPermission(req.auth.role, 'config.manage') }) }; });
    post('/api/remote-instances/:id/rcon/connect', 'server.manage', async req => { known(req.params.id); return { rcon: await rcon.connect(req.params.id, req.auth.username) }; });
    post('/api/remote-instances/:id/rcon/command', 'server.manage', async req => {
      known(req.params.id);
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).join(',') !== 'command') fail('RCON_COMMAND_BLOCKED');
      return { result: await rcon.execute(req.params.id, req.body.command, req.auth.username) };
    });
    post('/api/remote-instances/:id/rcon/kick', 'server.manage', async req => {
      known(req.params.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return { kick: await rcon.kick(req.params.id, { slot: body.slot, playerid: body.playerid, name: body.name, reason: body.reason }, req.auth.username) };
    });
  }

  // ---- credentials of a remote server (Block 18b): rcon and b3db only, write-only, under rmt_<id> in the vault
  if (remoteCredentials) {
    const KINDS = ['rcon', 'b3db'];
    const kindOf = value => (KINDS.includes(value) ? value : fail('REMOTE_ARGUMENT_INVALID'));
    // The RCON password is read at start; it changes only while the server is stopped (as for a local one).
    const change = async (req, remove) => {
      const id = req.params.id, kind = kindOf(req.params.kind);
      manager.instances.get(id);
      if (kind === 'rcon' && ['STARTING', 'RUNNING', 'STOPPING'].includes((await manager.savedRuntime(id))?.status)) fail('REMOTE_INSTANCE_RUNNING');
      const result = remove ? await remoteCredentials.remove(id, kind, exact(req.body, ['expectedSha256'])) : await remoteCredentials.set(id, kind, exact(req.body, ['value', 'expectedSha256']));
      if (kind === 'b3db') await b3?.database?.invalidate(id); // a new password needs a new connection test
      return { credential: { sha256: result.sha256, kind } };
    };
    get('/api/remote-instances/:id/credentials', 'config.manage', async req => {
      manager.instances.get(req.params.id);
      const { locked, initialized, sha256, digest, rcon: rconStatus, b3db } = await remoteCredentials.instanceStatus(req.params.id);
      return { credentials: { locked, initialized, sha256, digest, rcon: rconStatus, b3db } };
    });
    post('/api/remote-instances/:id/credentials/:kind', 'config.manage', req => change(req, false));
    post('/api/remote-instances/:id/credentials/:kind/remove', 'config.manage', req => change(req, true));
  }

  // ---- B3 through its database (Block 18b): B3 runs on the server; CONTROL reads and writes B3's database.
  if (b3) {
    const known = id => manager.instances.get(id);
    const queryInt = value => (value === undefined ? undefined : /^\d{1,10}$/.test(String(value)) ? Number(value) : -1);
    const view = req => ({ full: hasPermission(req.auth.role, 'config.manage') });
    const { database, admin } = b3;
    get('/api/remote-instances/:id/b3/database', 'config.manage', async req => { known(req.params.id); return { database: await database.read(req.params.id) }; });
    post('/api/remote-instances/:id/b3/database', 'config.manage', async req => { known(req.params.id); return { database: await database.save(req.params.id, req.body) }; });
    post('/api/remote-instances/:id/b3/database/remove', 'config.manage', async req => { known(req.params.id); return { database: await database.remove(req.params.id) }; });
    post('/api/remote-instances/:id/b3/database/test', 'config.manage', async req => { known(req.params.id); return { database: await database.test(req.params.id) }; });
    // B3 on the server owns its schema: CONTROL does not migrate a remote database.
    post('/api/remote-instances/:id/b3/database/migrate', 'server.manage', async () => fail('REMOTE_B3_MIGRATE_UNSUPPORTED'));
    const read = (suffix, action) => get(`/api/remote-instances/:id/b3/admin/${suffix}`, 'diagnostics.read', async req => { known(req.params.id); return action(req); });
    const write = (suffix, action) => post(`/api/remote-instances/:id/b3/admin/${suffix}`, 'server.manage', async req => { known(req.params.id); return { result: await action(req, req.body && typeof req.body === 'object' ? req.body : {}) }; });
    read('status', async req => ({ status: await admin.status(req.params.id) }));
    read('players', async req => ({ players: await admin.players(req.params.id, { search: typeof req.query.search === 'string' ? req.query.search : undefined, offset: queryInt(req.query.offset) }, view(req)) }));
    read('players/:clientId', async req => ({ player: await admin.player(req.params.id, queryInt(req.params.clientId), view(req)) }));
    read('admins', async req => ({ admins: await admin.admins(req.params.id, view(req)) }));
    read('penalties', async req => ({ penalties: await admin.penalties(req.params.id, { type: req.query.type, status: req.query.status, offset: queryInt(req.query.offset) }, view(req)) }));
    read('groups', async req => ({ groups: await admin.groups(req.params.id) }));
    read('commands', async req => ({ commands: await admin.commands(req.params.id) }));
    write('players/:clientId/ban', (req, body) => admin.addBan(req.params.id, queryInt(req.params.clientId), { kind: body.kind, durationMinutes: body.durationMinutes, reason: body.reason, kick: body.kick === true }, req.auth.username));
    write('players/:clientId/kick', (req, body) => admin.kick(req.params.id, queryInt(req.params.clientId), body.reason === undefined ? '' : body.reason, req.auth.username));
    write('players/:clientId/unban', req => admin.unban(req.params.id, queryInt(req.params.clientId), req.auth.username));
    write('players/:clientId/group', (req, body) => admin.setGroup(req.params.id, queryInt(req.params.clientId), body.groupId, req.auth.username));
    write('penalties/:penaltyId/lift', req => admin.liftWarning(req.params.id, queryInt(req.params.penaltyId), req.auth.username));
  }

  // B3 itself is not run for remote servers (UDP and the live game log do not travel through SSH).
  app.all(new RegExp('^/api/remote-instances/[^/]+/b3(?!/(?:database|admin)(?:/|$))(?:/.*)?$'), requirePermission('diagnostics.read'), route(async () => fail('REMOTE_B3_UNSUPPORTED')));
}

// What the permission map (RBAC_ENDPOINT_BINDINGS) lists for these routes.
export const REMOTE_LINUX_BINDINGS = Object.freeze([
  { area: 'remote-linux-read', permission: 'diagnostics.read', routes: ['GET /api/remote-hosts', 'GET /api/remote-hosts/:id/docker', 'GET /api/remote-instances', 'GET /api/remote-instances/:id', 'GET /api/remote-instances/:id/health', 'GET /api/remote-instances/:id/logs', 'GET /api/remote-instances/:id/rcon/online'] },
  { area: 'remote-linux-manage', permission: 'server.manage', routes: ['POST /api/remote-hosts', 'DELETE /api/remote-hosts/:id', 'POST /api/remote-hosts/:id/hostkey/probe', 'POST /api/remote-hosts/:id/hostkey/trust', 'POST /api/remote-hosts/:id/docker/confirm', 'DELETE /api/remote-hosts/:id/docker/confirm', 'POST /api/remote-hosts/:id/docker/image', 'POST /api/remote-instances/:id/deployment', 'POST /api/remote-instances/:id/start', 'POST /api/remote-instances/:id/stop', 'POST /api/remote-instances/:id/restart', 'POST /api/remote-instances/:id/recover', 'POST /api/remote-instances/:id/network', 'GET /api/remote-instances/:id/rcon', 'POST /api/remote-instances/:id/rcon/connect', 'POST /api/remote-instances/:id/rcon/command', 'POST /api/remote-instances/:id/rcon/kick'] },
  { area: 'remote-linux-install', permission: 'install.execute', routes: ['POST /api/remote-instances'] },
  { area: 'remote-linux-update', permission: 'update.execute', routes: ['POST /api/remote-instances/:id/update', 'POST /api/remote-instances/:id/core/rollback'] },
  { area: 'remote-linux-b3-read', permission: 'diagnostics.read', routes: ['status', 'players', 'players/:clientId', 'admins', 'penalties', 'groups', 'commands'].map(suffix => `GET /api/remote-instances/:id/b3/admin/${suffix}`) },
  { area: 'remote-linux-b3-manage', permission: 'server.manage', routes: ['POST /api/remote-instances/:id/b3/database/migrate', ...['players/:clientId/ban', 'players/:clientId/kick', 'players/:clientId/unban', 'players/:clientId/group', 'penalties/:penaltyId/lift'].map(suffix => `POST /api/remote-instances/:id/b3/admin/${suffix}`)] },
  { area: 'remote-linux-config', permission: 'config.manage', routes: ['GET /api/remote-instances/:id/credentials', 'POST /api/remote-instances/:id/credentials/:kind', 'POST /api/remote-instances/:id/credentials/:kind/remove', 'GET /api/remote-instances/:id/b3/database', 'POST /api/remote-instances/:id/b3/database', 'POST /api/remote-instances/:id/b3/database/remove', 'POST /api/remote-instances/:id/b3/database/test', 'GET /api/remote-hosts/:id/credentials', 'POST /api/remote-hosts/:id/credentials/ssh', 'POST /api/remote-hosts/:id/credentials/ssh/remove', 'GET /api/remote-instances/:id/config', 'PUT /api/remote-instances/:id/config', 'GET /api/remote-instances/:id/backups', 'POST /api/remote-instances/:id/backups', 'POST /api/remote-instances/:id/backups/:backupId/restore'] },
]);
