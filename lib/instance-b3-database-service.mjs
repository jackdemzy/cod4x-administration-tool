import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeDirectory } from './b3-config.mjs';
import { runDatabaseHelper, readAuditedSql } from './b3-database-helper.mjs';
import {
  validateDatabaseSettings, buildMysqlDsn, parseSchemaFile, classifySchema, planMigration,
  splitSqlStatements, statementTable, CORE_SQL, EBC_TABLES,
} from './b3-database.mjs';

const fail = (code, extra) => { throw Object.assign(new Error(code), { code, ...extra }); };
const BACKUP_HEADER = '-- COD4X CONTROL B3 backup v1';
// Errors that describe the database, not CONTROL: reported as a check result.
const DATABASE_CODES = new Set(['DB_UNREACHABLE', 'DB_AUTH_FAILED', 'DB_ACCESS_DENIED', 'DB_NOT_FOUND', 'DB_DRIVER_MISSING', 'DB_ERROR', 'DB_HELPER_FAILED', 'DB_HELPER_TIMEOUT']);
// Identity the b3db password is bound to (no secret): changing it needs re-entry.
const bindingOf = settings => `${settings.host}:${settings.port}:${settings.username}`;
const schemaCode = state => ({ PARTIAL: 'SCHEMA_PARTIAL', OUTDATED: 'SCHEMA_OUTDATED' })[state] || null;

// Re-reads a backup written by the helper and checks hash, header and one
// "-- TABLE <name> ROWS <n>" marker per table with the helper's row counts.
export async function verifyBackup(file, { sha256, tables }) {
  let bytes;
  try { bytes = await fs.readFile(file); } catch { fail('BACKUP_FAILED'); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) fail('BACKUP_FAILED');
  const text = bytes.toString('utf8');
  if (!text.startsWith(`${BACKUP_HEADER}\n`)) fail('BACKUP_FAILED');
  const markers = [...text.matchAll(/^-- TABLE (\S+) ROWS (\d+)$/gm)].map(match => [match[1], Number(match[2])]);
  const expected = Object.entries(tables || {});
  if (markers.length !== expected.length || expected.some(([name, rows]) => !markers.some(([marker, count]) => marker === name && count === rows))) fail('BACKUP_FAILED');
}

// Per-instance B3 database setup (Block 14): settings in <home>/b3/database.json
// (no password), password in the vault (kind b3db), test -> backup -> migration.
// Events and results never carry the password or the DSN.
export class InstanceB3DatabaseService {
  #busy = new Set();
  #credentialGeneration = new Map();
  constructor({ store, credentials, environment, b3IsRunning, onEvent = () => {}, helper = runDatabaseHelper, now = () => new Date() }) {
    Object.assign(this, { store, credentials, environment, b3IsRunning, onEvent, helper, now });
  }
  #paths(id) {
    const directory = path.join(this.store.get(id).homePath, 'b3');
    return { directory, file: path.join(directory, 'database.json'), backups: path.join(directory, 'backups') };
  }
  async #exclusive(id, action) {
    if (this.#busy.has(id)) fail('B3_DATABASE_BUSY');
    this.#busy.add(id);
    try { return await action(); } finally { this.#busy.delete(id); }
  }
  async #load(id) {
    try { return JSON.parse(await fs.readFile(this.#paths(id).file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('B3_DATABASE_STATE_INVALID'); }
  }
  async #store(id, document) {
    const { directory, file } = this.#paths(id);
    await safeDirectory(directory, true);
    const temporary = `${file}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async #settings(id) {
    const document = await this.#load(id);
    if (!document?.settings) fail('B3_DATABASE_NOT_CONFIGURED');
    return { document, settings: validateDatabaseSettings(document.settings) };
  }
  async #environment() {
    const { pythonPath, b3Path } = await this.environment.read() || {};
    if (!pythonPath) fail('B3_PYTHON_NOT_CONFIGURED');
    if (!b3Path) fail('B3_SOURCE_NOT_CONFIGURED');
    return { pythonPath, b3Path };
  }
  // The vault scope is exclusive across all instances (RCON, server starts), so
  // it only lasts until the request with the password is written to the helper's
  // stdin; the helper then runs without holding the vault. A lock aborts before
  // the call. The password only goes to the host/port/user it was entered for.
  async #helperCall(id, request, onSent = () => {}) {
    const document = await this.#load(id);
    if (!document?.passwordBinding || document.passwordBinding !== bindingOf(request.connection)) fail('B3_DATABASE_PASSWORD_REENTRY_REQUIRED');
    let pending = null;
    try {
      await this.credentials.withRuntimeCredentials(id, async (credentials, signal) => {
        if (signal?.aborted) fail('VAULT_LOCKED');
        if (!credentials.b3db) fail('B3_DATABASE_PASSWORD_MISSING');
        let written;
        const requestWritten = new Promise(resolve => { written = resolve; });
        pending = this.helper({ ...request, password: credentials.b3db }, { onRequestWritten: () => { onSent(); written(); } });
        await Promise.race([requestWritten, pending.then(() => {}, () => {})]);
      });
    } catch (error) {
      // A lock right after the request was written: the helper still runs; wait
      // for it so nothing overlaps, then report the lock.
      const result = pending ? await pending.catch(() => null) : null;
      if (result) error.helperResult = result;
      throw error;
    }
    return pending;
  }
  #event(event, details) { this.onEvent({ event, ...details }); }
  // Stores a check result; a ready database switches the instance to MySQL for good
  // (mysqlEnabled) until its settings are removed, so B3 never silently falls back.
  // Merges into the current file (a concurrent b3db change may have rebound the
  // password); a result from before that change is dropped, never stored as ready.
  async #check(id, document, lastCheck, generation) {
    if (generation !== undefined && generation !== this.#generationOf(id)) return false;
    const current = await this.#load(id) || document;
    await this.#store(id, { ...current, mysqlEnabled: current.mysqlEnabled === true || lastCheck?.ready === true, lastCheck });
    return true;
  }
  #generationOf(id) { return this.#credentialGeneration.get(id) || 0; }
  isBusy(id) { return this.#busy.has(id); }
  // B3 start holds the same per-instance lock as test/migrate, so a migration can
  // never begin between the readiness check and the B3 spawn (and vice versa).
  withStartGuard(id, action) { return this.#exclusive(id, action); }
  async read(id) {
    const document = await this.#load(id);
    let passwordConfigured = null;
    try { passwordConfigured = (await this.credentials.instanceStatus(id)).b3db?.configured ?? null; } catch { passwordConfigured = null; }
    const passwordBound = Boolean(document?.settings && document.passwordBinding === bindingOf(document.settings));
    return { settings: document?.settings || null, passwordConfigured, passwordBound, lastCheck: document?.lastCheck || null, ready: document?.lastCheck?.ready === true, mysqlEnabled: document?.mysqlEnabled === true };
  }
  async save(id, input) {
    return this.#exclusive(id, async () => {
      const settings = validateDatabaseSettings(input);
      const document = await this.#load(id);
      // The password binding is kept; it only matches again for the same host/port/user.
      await this.#store(id, { version: 1, settings, mysqlEnabled: document?.mysqlEnabled === true, passwordBinding: document?.passwordBinding || null, lastCheck: null });
      return this.read(id);
    });
  }
  // Explicit way back to SQLite: forget the database settings and readiness.
  async remove(id) {
    return this.#exclusive(id, async () => {
      if (await this.b3IsRunning(id)) fail('B3_RUNNING');
      await fs.rm(this.#paths(id).file, { force: true });
      return this.read(id);
    });
  }
  // The b3db password was entered or removed: readiness needs a new test, and
  // the password is bound to the settings it was entered for.
  async invalidate(id) {
    this.#credentialGeneration.set(id, this.#generationOf(id) + 1);
    const document = await this.#load(id);
    if (!document) return;
    await this.#store(id, { ...document, passwordBinding: document.settings ? bindingOf(document.settings) : null, lastCheck: null });
  }
  async test(id) {
    return this.#exclusive(id, async () => {
      const { document, settings } = await this.#settings(id);
      const { pythonPath, b3Path } = await this.#environment();
      const expected = parseSchemaFile((await readAuditedSql(b3Path, CORE_SQL)).text).tables;
      const checkedAt = this.now().toISOString();
      const generation = this.#generationOf(id);
      let probe;
      try { probe = await this.#helperCall(id, { pythonPath, op: 'probe', connection: settings }); }
      catch (error) {
        if (!DATABASE_CODES.has(error.code)) throw error;
        await this.#check(id, document, { connection: error.code, schema: null, code: error.code, ready: false, checkedAt }, generation);
        this.#event('b3.database.tested', { instanceId: id, code: error.code });
        return { connection: error.code, code: error.code, schema: null, ready: false };
      }
      const schema = classifySchema(expected, probe.tables);
      const stored = await this.#check(id, document, { connection: 'OK', schema: schema.state, missingTables: schema.missingTables, missingColumns: schema.missingColumns, code: schemaCode(schema.state), ready: schema.state === 'COMPLETE', checkedAt }, generation);
      const ready = stored && schema.state === 'COMPLETE';
      this.#event('b3.database.tested', { instanceId: id, code: schemaCode(schema.state), schema: schema.state });
      return { connection: 'OK', code: schemaCode(schema.state), schema, ready };
    });
  }
  async #backupTarget(id) {
    const { directory, backups } = this.#paths(id);
    await safeDirectory(directory, true);
    await safeDirectory(backups, true);
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    for (let index = 1; ; index++) {
      const target = path.join(backups, `b3-${stamp}${index === 1 ? '' : `-${index}`}.sql`);
      if (!await fs.lstat(target).then(() => true, () => false)) return target;
    }
  }
  async migrate(id, { ebcOptIn = false, confirmation } = {}) {
    return this.#exclusive(id, async () => {
      if (await this.b3IsRunning(id)) fail('B3_RUNNING');
      const { document, settings } = await this.#settings(id);
      const { pythonPath, b3Path } = await this.#environment();
      let backup = null, applied = false, marked = false;
      const generation = this.#generationOf(id);
      const call = (op, extra = {}, onSent) => this.#helperCall(id, { pythonPath, op, connection: settings, ...extra }, onSent);
      const failed = async (code, cause, schema = null) => {
        await this.#check(id, document, { connection: 'OK', schema, code, ready: false, backup, checkedAt: this.now().toISOString() });
        this.#event('b3.database.migration_failed', { instanceId: id, code, cause, backupSha256: backup?.sha256 || null });
        fail(code, { backup });
      };
      // A vault lock is never reported as a failed migration. Before any SQL ran
      // nothing is recorded; once SQL ran the state is unknown and not ready.
      const locked = error => error?.code === 'VAULT_LOCKED' || error?.code === 'VAULT_OPERATION_BUSY';
      try {
        const core = await readAuditedSql(b3Path, CORE_SQL);
        const expected = parseSchemaFile(core.text).tables;
        const before = await call('probe');
        const schema = classifySchema(expected, before.tables);
        const plan = planMigration({ schema, tableCount: Object.keys(before.tables).length, ebcOptIn, confirmation });
        if (plan.backup) {
          const target = await this.#backupTarget(id);
          try {
            const written = await call('backup', { target });
            if (path.resolve(written.path) !== target) fail('BACKUP_FAILED');
            await verifyBackup(target, written);
            backup = { path: target, sha256: written.sha256 };
          } catch (error) {
            if (locked(error)) {
              // The helper finished the backup before the lock: report it if it verifies.
              const written = error.helperResult;
              if (written && path.resolve(written.path) === target && await verifyBackup(target, written).then(() => true, () => false)) {
                error.backup = { path: target, sha256: written.sha256 };
                this.#event('b3.database.backup_created', { instanceId: id, backupSha256: written.sha256, tables: Object.keys(before.tables) });
              }
              throw error;
            }
            await failed('BACKUP_FAILED', error.code || 'BACKUP_FAILED', schema.state);
          }
          this.#event('b3.database.backup_created', { instanceId: id, backupSha256: backup.sha256, tables: Object.keys(before.tables) });
        }
        // Fails closed if the backend dies mid-migration: not ready until re-tested.
        await this.#check(id, document, { connection: 'OK', schema: schema.state, code: 'MIGRATION_IN_PROGRESS', ready: false, backup, checkedAt: this.now().toISOString() });
        marked = true;
        for (const file of plan.files) {
          // Hash checked again right before execution; the core schema only
          // creates missing tables (b3.sql inserts default groups without IGNORE).
          const sql = await readAuditedSql(b3Path, file);
          let statements = splitSqlStatements(sql.text);
          if (file === CORE_SQL) statements = statements.filter(statement => schema.missingTables.includes(statementTable(statement)));
          // applied: the helper received SQL (a busy or locked vault before that changes nothing).
          try { await call('apply', { statements }, () => { applied = true; }); }
          catch (error) { if (locked(error)) throw error; await failed('MIGRATION_FAILED', error.code || 'DB_ERROR', schema.state); }
        }
        let after;
        try { after = await call('probe'); } catch (error) { if (locked(error)) throw error; await failed('MIGRATION_FAILED', error.code || 'DB_ERROR', schema.state); }
        const result = classifySchema(expected, after.tables);
        if (result.state !== 'COMPLETE' || (ebcOptIn && !EBC_TABLES.every(table => after.tables[table]))) await failed('MIGRATION_FAILED', 'SCHEMA_INCOMPLETE', result.state);
        const stored = await this.#check(id, document, { connection: 'OK', schema: result.state, missingTables: [], missingColumns: {}, code: null, ready: true, backup, checkedAt: this.now().toISOString() }, generation);
        this.#event('b3.database.migrated', { instanceId: id, files: plan.files, backupSha256: backup?.sha256 || null });
        return { backup, files: plan.files, schema: result, ready: stored };
      } catch (error) {
        // Nothing ran: put the previous state back instead of the in-progress marker.
        if (locked(error) && !applied && marked) await this.#check(id, document, document.lastCheck ?? null, generation);
        if (locked(error) && applied) {
          await this.#check(id, document, { connection: 'OK', schema: null, code: error.code, ready: false, backup, checkedAt: this.now().toISOString() });
          this.#event('b3.database.migration_failed', { instanceId: id, code: error.code, cause: error.code, backupSha256: backup?.sha256 || null });
        }
        throw error;
      }
    });
  }
  // Block 15 entry point for the admin service: a catalog query on a ready
  // database, through the same password binding and short vault scope. Writes
  // run under the instance lock (never during a test, migration or B3 start).
  async query(id, name, params, { write = false } = {}) {
    const run = async () => {
      const document = await this.#load(id);
      if (document?.lastCheck?.ready !== true || !document.settings) fail('B3_DATABASE_NOT_READY');
      const { pythonPath } = await this.#environment();
      return this.#helperCall(id, { pythonPath, op: 'query', connection: validateDatabaseSettings(document.settings), name, params });
    };
    return write ? this.#exclusive(id, run) : run();
  }
  // Only for writing b3.xml inside the vault transfer scope (B3 start).
  async connectionFor(id, password) {
    const document = await this.#load(id);
    if (document?.lastCheck?.ready !== true || !document.settings || document.passwordBinding !== bindingOf(document.settings)) return null;
    return { dsn: buildMysqlDsn(document.settings, password.toString('utf8')) };
  }
}
