// Block 16b final review: regression tests for the eight findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ServerInstanceStore } from '../lib/server-instance-store.mjs';
import { InstanceB3PluginService } from '../lib/instance-b3-plugin-service.mjs';
import { hashB3Module } from '../lib/b3-plugin-hash.mjs';
import { normalizedHash } from '../lib/b3-dependencies.mjs';
import { renderB3PluginTemplate } from '../lib/b3-plugin-template.mjs';
import { isLoopbackAddress, isB3PluginCodePath, isB3PluginTextPath, localOnlyGuard, publicBlockers } from '../lib/b3-plugin-routes.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer(file) {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/${file}'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}
const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const serverSource = () => fs.readFile(fileURLToPath(new URL('../installer-server.mjs', import.meta.url)), 'utf8');

const TEMPLATE = '[settings]\nmessage: hi\n';
const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b3-plugin-final-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, 'game');
  const executablePath = path.join(root, 'core', 'cod4x18_dedrun.exe');
  await fs.mkdir(path.join(basePath, 'main'), { recursive: true });
  await fs.mkdir(path.join(basePath, 'zone'), { recursive: true });
  await fs.mkdir(path.dirname(executablePath));
  await fs.writeFile(path.join(basePath, 'main', 'pak0.iwd'), 'fixture');
  await fs.writeFile(path.join(basePath, 'zone', 'common.ff'), 'fixture');
  await fs.writeFile(executablePath, 'fixture');
  const store = new ServerInstanceStore({ root: path.join(root, 'servers'), registryFile: path.join(root, 'instances.json'), checkPort: async () => {} });
  await store.load();
  const instance = await store.create({ id: 'public-01', name: 'Public 01', platform: 'windows', serverCore: { executablePath, version: '21.5' }, basePath, port: 28960 });
  const b3Path = path.join(root, 'ebc');
  const moduleDir = path.join(b3Path, 'b3', 'plugins', 'welcome');
  const loginDir = path.join(b3Path, 'b3', 'plugins', 'login');
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.mkdir(loginDir, { recursive: true });
  await fs.mkdir(path.join(b3Path, 'b3', 'conf'), { recursive: true });
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class WelcomePlugin: pass\n');
  await fs.writeFile(path.join(loginDir, '__init__.py'), 'class LoginPlugin: pass\n');
  await fs.writeFile(path.join(b3Path, 'b3', 'conf', 'plugin_welcome.ini'), TEMPLATE);
  const catalog = [
    { name: 'welcome', location: 'plugins', module: 'package', sha256: (await hashB3Module(moduleDir)).sha256, configTemplate: 'b3/conf/plugin_welcome.ini', configTemplateSha256: normalizedHash(Buffer.from(TEMPLATE)), requiresConfigFile: true, requiresPlugins: [], requiresParsers: [], pythonModules: [] },
    // Like autoreg, codam, login and makeroom: a config file is required, but B3 ships no template.
    { name: 'login', location: 'plugins', module: 'package', sha256: (await hashB3Module(loginDir)).sha256, configTemplate: null, configTemplateSha256: null, requiresConfigFile: true, requiresPlugins: [], requiresParsers: [], pythonModules: [] },
  ];
  const service = new InstanceB3PluginService({ store, environment: { read: async () => ({ pythonPath: null, b3Path }) }, catalog });
  return { service, moduleDir, b3: path.join(instance.homePath, 'b3') };
}
const row = async (service, name) => (await service.list('public-01')).plugins.find(item => item.name === name);
const codes = plan => plan.blockers.map(entry => entry.code);

// ---- 1: unknown restart codes must not blank the renderer ----
const integrationData = restart => ({ settings: { hideCommands: false, prefix: '!', hideLevel: 20 }, plan: { enabled: false, blockers: [], warnings: [] }, b3hide: null, knownHash: false, restart, authLevels: [], vault: { locked: false, initialized: true } });
const integrationPanel = async (restart, de = true) => (await renderer('instance-b3-integration.jsx'))('B3IntegrationPanel', { data: integrationData(restart), canManage: true, de, busy: false, onSave() {}, onSetPassword() {} });

test('1: integration panel renders the PLUGINS_CHANGED restart hint', { skip }, async () => {
  assert.match(await integrationPanel({ server: null, b3: 'PLUGINS_CHANGED' }), /Plugin-Änderungen wirken erst nach einem B3-Neustart\./);
  assert.match(await integrationPanel({ server: null, b3: 'PLUGINS_CHANGED' }, false), /Plugin changes take effect after a B3 restart\./);
});

test('1: integration panel shows an unknown restart code instead of throwing', { skip }, async () => {
  const html = await integrationPanel({ server: 'SOMETHING_NEW', b3: 'OTHER_CODE', other: 'X_CODE' });
  for (const code of ['SOMETHING_NEW', 'OTHER_CODE', 'X_CODE']) assert.ok(html.includes(code), code);
});

// ---- 2: custom code hashes are line-ending normalized like hashB3Module ----
test('2: CRLF custom code is OK after create and save, and the start plan has no integrity blocker', async t => {
  const { service } = await setup(t);
  const crlf = renderB3PluginTemplate('crlfplug').code.replace(/\n/g, '\r\n');
  const created = await service.createCustom('public-01', { name: 'crlfplug', code: crlf });
  assert.equal(created.state, 'DISABLED');
  assert.equal((await service.setEnabled('public-01', 'crlfplug', true)).state, 'ENABLED');
  assert.deepEqual(codes(await service.plan('public-01')), []);
  const read = await service.readCode('public-01', 'crlfplug');
  assert.equal(read.sha256, sha(Buffer.from(crlf, 'utf8')), 'the editor conflict hash is the hash of the file bytes');
  const saved = await service.saveCode('public-01', 'crlfplug', { code: `${crlf}# edited\r\n`, expectedSha256: read.sha256 });
  assert.equal(saved.sha256, (await service.readCode('public-01', 'crlfplug')).sha256, 'the returned hash is valid for the next save');
  assert.equal((await row(service, 'crlfplug')).state, 'ENABLED');
  assert.deepEqual(codes(await service.plan('public-01')), []);
  // A stale editor hash is still a conflict.
  await assert.rejects(service.saveCode('public-01', 'crlfplug', { code: crlf, expectedSha256: read.sha256 }), { code: 'B3_PLUGIN_CONFLICT' });
});

// ---- 3: start blockers carry per-plugin detail ----
test('3: publicBlockers keeps only code and plugin, nothing else', () => {
  const error = Object.assign(new Error('B3_PLUGIN_CONFIG_MISSING'), { code: 'B3_PLUGIN_CONFIG_MISSING', blockers: [{ code: 'B3_PLUGIN_CONFIG_MISSING', plugin: 'login', secret: 'hunter22' }, { code: 'RCON_PASSWORD_MISSING', value: 'x' }, null, { plugin: 'nocode' }] });
  assert.deepEqual(publicBlockers(error), [{ code: 'B3_PLUGIN_CONFIG_MISSING', plugin: 'login' }, { code: 'RCON_PASSWORD_MISSING' }]);
  assert.equal(publicBlockers(new Error('x')), null);
});

test('3: the instance route error JSON carries the blockers', async () => {
  assert.match(await serverSource(), /const blockers = publicBlockers\(error\);[\s\S]{0,600}\.\.\.\(blockers \? \{ blockers \} : \{\}\)/);
});

test('3: the B3 manager error shows each plugin blocker as text with the plugin name', { skip }, async () => {
  const render = await renderer('instance-b3-runtime.jsx');
  const error = { code: 'B3_PLUGIN_CONFIG_MISSING', blockers: [{ code: 'B3_PLUGIN_CONFIG_MISSING', plugin: 'login' }, { code: 'B3_PLUGIN_NOT_APPROVED', plugin: 'duel' }] };
  const de = render('B3StartError', { error, de: true });
  assert.match(de, /Die Konfigurationsdatei eines aktivierten B3-Plugins fehlt\..*login/);
  assert.match(de, /Ein aktiviertes B3-Plugin ist nicht freigegeben\..*duel/);
  const en = render('B3StartError', { error, de: false });
  assert.match(en, /The config file of an enabled B3 plugin is missing\..*login/);
  assert.match(render('B3StartError', { error: { code: 'B3_DEPENDENCIES_BLOCKED' }, de: true }), /B3_DEPENDENCIES_BLOCKED/);
  assert.equal(render('B3StartError', { error: null, de: true }), '');
});

// ---- 4: shipped plugins that need a config file but have no template ----
test('4: a required config without template can be saved and the start plan is then clean', async t => {
  const { service, b3 } = await setup(t);
  assert.equal((await row(service, 'login')).configType, 'ini', 'the Config action is offered before enabling');
  const enabled = await service.setEnabled('public-01', 'login', true);
  assert.equal(enabled.configType, 'ini');
  assert.deepEqual(codes(await service.plan('public-01')), ['B3_PLUGIN_CONFIG_MISSING']);
  const empty = await service.readConfig('public-01', 'login');
  assert.deepEqual(empty, { text: '', sha256: EMPTY_SHA, configType: 'ini' });
  await service.saveConfig('public-01', 'login', { text: '[settings]\nthreshold: 1000\n', expectedSha256: empty.sha256 });
  assert.equal(await fs.readFile(path.join(b3, 'plugins', 'login.ini'), 'utf8'), '[settings]\nthreshold: 1000\n');
  const plan = await service.plan('public-01');
  assert.deepEqual(codes(plan), []);
  assert.equal(plan.plugins.find(item => item.name === 'login').configPath, path.join(b3, 'plugins', 'login.ini'));
});

const pluginsPanel = async (plugins, props = {}) => (await renderer('instance-b3-plugins.jsx'))('B3PluginsPanel', { data: { plugins, revision: 1, restart: null }, de: false, busy: false, permissions: { manage: true, code: true }, onToggle() {}, onApprove() {}, onOpenConfig() {}, onOpenCode() {}, onSaveEditor() {}, onCloseEditor() {}, onCreate() {}, onDelete() {}, ...props });
const pluginRow = overrides => ({ name: 'login', source: 'shipped', enabled: true, sha256: null, expectedSha256: null, configType: 'ini', requires: { plugins: [], pythonModules: [] }, reason: null, state: 'ENABLED', modulePath: 'b3/plugins/login', ...overrides });

test('4: the panel shows the Config button for a required config without template', { skip }, async () => {
  assert.match(await pluginsPanel([pluginRow()]), />Config</);
});

// ---- 5: re-approval of a shipped plugin that changed after its approval ----
test('5: an approved shipped plugin that changes again can be approved again', async t => {
  const { service, moduleDir } = await setup(t);
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class WelcomePlugin: pass\n# B\n');
  await service.setEnabled('public-01', 'welcome', true);
  await service.approve('public-01', 'welcome', (await hashB3Module(moduleDir)).sha256);
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class WelcomePlugin: pass\n# C\n');
  const changed = await row(service, 'welcome');
  assert.equal(changed.state, 'INTEGRITY_MISMATCH');
  assert.equal(changed.sha256, (await hashB3Module(moduleDir)).sha256);
  assert.deepEqual(codes(await service.plan('public-01')), ['B3_PLUGIN_INTEGRITY_FAILED']);
  assert.equal((await service.approve('public-01', 'welcome', changed.sha256)).state, 'ENABLED');
  assert.deepEqual(codes(await service.plan('public-01')), []);
});

test('5: an approved shipped plugin that returns to the catalog file is OK in list and plan', async t => {
  const { service, moduleDir } = await setup(t);
  const original = await fs.readFile(path.join(moduleDir, '__init__.py'));
  await fs.writeFile(path.join(moduleDir, '__init__.py'), 'class WelcomePlugin: pass\n# B\n');
  await service.setEnabled('public-01', 'welcome', true);
  await service.approve('public-01', 'welcome', (await hashB3Module(moduleDir)).sha256);
  await fs.writeFile(path.join(moduleDir, '__init__.py'), original);
  assert.equal((await row(service, 'welcome')).state, 'ENABLED');
  assert.deepEqual(codes(await service.plan('public-01')), []);
});

test('5: the panel offers Approve for a changed shipped plugin, not for a custom one', { skip }, async () => {
  const hash = 'c'.repeat(64);
  const shipped = await pluginsPanel([pluginRow({ name: 'welcome', state: 'INTEGRITY_MISMATCH', sha256: hash, reason: 'B3_PLUGIN_INTEGRITY_FAILED' })]);
  assert.ok(shipped.includes(hash));
  assert.match(shipped, />Approve</);
  const custom = await pluginsPanel([pluginRow({ name: 'mine', source: 'custom', state: 'INTEGRITY_MISMATCH', sha256: hash, reason: 'B3_PLUGIN_INTEGRITY_FAILED' })]);
  assert.doesNotMatch(custom, />Approve</);
  const unreadable = await pluginsPanel([pluginRow({ name: 'welcome', state: 'INTEGRITY_MISMATCH', sha256: null, reason: 'B3_PLUGIN_INTEGRITY_FAILED' })]);
  assert.doesNotMatch(unreadable, />Approve</);
});

// ---- 6: code routes are local only ----
const fakeResponse = () => { const res = { statusCode: 200, body: null, status(code) { res.statusCode = code; return res; }, json(body) { res.body = body; return res; } }; return res; };
test('6: the four code routes are local only, other plugin routes are not', () => {
  for (const route of ['/api/instances/a/b3/plugins/custom', '/api/instances/a/b3/plugins/custom/', '/api/instances/a/b3/plugins/custom/mine/code', '/api/instances/a/b3/plugins/custom/mine/code/', '/api/instances/a/b3/plugins/custom/mine', '/api/instances/a/B3/Plugins/Custom/mine/CODE']) assert.ok(isB3PluginCodePath(route), route);
  for (const route of ['/api/instances/a/b3/plugins', '/api/instances/a/b3/plugins/welcome/config', '/api/instances/a/b3/plugins/welcome/enable']) assert.ok(!isB3PluginCodePath(route), route);
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(address));
  for (const address of ['192.168.1.5', '::ffff:10.0.0.2', undefined]) assert.ok(!isLoopbackAddress(address));
});

test('6: the guard rejects a non-loopback code request like the credential guard and passes loopback', () => {
  const guard = localOnlyGuard(req => isB3PluginCodePath(req.path));
  let passed = 0;
  const remote = fakeResponse();
  guard({ path: '/api/instances/a/b3/plugins/custom/mine/code', socket: { remoteAddress: '192.168.1.5' } }, remote, () => { passed++; });
  assert.equal(passed, 0);
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.body.code, 'CREDENTIAL_LOCAL_ONLY');
  guard({ path: '/api/instances/a/b3/plugins/custom/mine/code', socket: { remoteAddress: '127.0.0.1' } }, fakeResponse(), () => { passed++; });
  guard({ path: '/api/instances/a/b3/plugins/welcome/config', socket: { remoteAddress: '192.168.1.5' } }, fakeResponse(), () => { passed++; });
  assert.equal(passed, 2);
});

test('6: the server wires the local-only guard for code routes and reuses it for credentials', async () => {
  const text = await serverSource();
  assert.match(text, /app\.use\(localOnlyGuard\(req => isB3PluginCodePath\(req\.path\)\)\)/);
  assert.match(text, /isLoopbackAddress\(req\.socket\.remoteAddress\)|localOnlyGuard\(isCredentialRequest/);
});

// ---- 8: the changelog describes the write serialization accurately ----
test('8: the changelog names the per-instance queue, not an exclusive lock', async () => {
  const text = await fs.readFile(fileURLToPath(new URL('../CHANGELOG-4.18.21.md', import.meta.url)), 'utf8');
  assert.doesNotMatch(text, /exclusive lock/);
  assert.match(text, /plugin service's own per-instance queue/);
});

// ---- 7: trailing slash on text routes ----
test('7: plugin text routes accept an optional trailing slash', async () => {
  for (const route of ['/api/instances/a/b3/plugins/welcome/config', '/api/instances/a/b3/plugins/welcome/config/', '/api/instances/a/b3/plugins/custom', '/api/instances/a/b3/plugins/custom/', '/api/instances/a/b3/plugins/custom/mine/code/']) assert.ok(isB3PluginTextPath(route), route);
  assert.ok(!isB3PluginTextPath('/api/instances/a/b3/plugins/welcome/enable'));
  assert.match(await serverSource(), /const isB3PluginTextRequest = req => isB3PluginTextPath\(req\.path\)/);
});
