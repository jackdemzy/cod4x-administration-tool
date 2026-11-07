import test from 'node:test';
import assert from 'node:assert/strict';
import { renderB3PluginTemplate, b3PluginClassName } from '../lib/b3-plugin-template.mjs';
import { validateB3PluginIni, validateB3PluginXml, validateB3PluginCode, checkB3PluginText } from '../lib/b3-plugin-validate.mjs';
import { B3_PLUGIN_MESSAGES, b3PluginMessage } from '../lib/b3-plugin-messages.mjs';

test('template: code and config for a new plugin', () => {
  const { code, config } = renderB3PluginTemplate('myplug');
  assert.match(code, /class MyplugPlugin\(b3\.plugin\.Plugin\)/);
  assert.match(code, /def onStartup\(self\)/);
  assert.match(code, /def cmd_myplug\(self, data, client, cmd=None\)/);
  assert.match(code, /getPlugin\('admin'\)/);
  assert.match(code, /registerCommand\(self, cmd, level, func, alias\)/);
  const imports = code.split('\n').filter(l => /^(import|from)\s/.test(l)).map(l => l.trim());
  assert.deepEqual(imports, ['import b3', 'import b3.plugin']);
  assert.match(config, /\[commands\]/);
  assert.match(config, /myplug: 1/);
  assert.match(config, /\[settings\]/);
  assert.doesNotThrow(() => validateB3PluginCode('myplug', code));
  assert.equal(validateB3PluginIni(config).ok, true);
});

test('template: class name follows Python str.title() like B3 loader', () => {
  assert.equal(b3PluginClassName('myplug'), 'MyplugPlugin');
  assert.equal(b3PluginClassName('my_plug'), 'My_PlugPlugin');
  assert.equal(b3PluginClassName('abc2def'), 'Abc2DefPlugin');
  const { code } = renderB3PluginTemplate('my_plug');
  assert.match(code, /class My_PlugPlugin\(b3\.plugin\.Plugin\)/);
  assert.doesNotThrow(() => validateB3PluginCode('my_plug', code));
});

test('template: config-file plugin with configured message', () => {
  const { code, config } = renderB3PluginTemplate('myplug');
  assert.match(code, /requiresConfigFile = True/);
  assert.match(code, /def onLoadConfig\(self\)/);
  assert.match(code, /client\.message\(self\._message\)/);
  assert.match(code, /'Hello from myplug'/);
  assert.match(config, /\[settings\]\nmessage: Hello from myplug/);
});

test('ini: accepted forms', () => {
  const ini = '; comment\n# other\nrem old\n[a]\nk = v\nk2: v2\nlong: one\n  two\n\n[b]\nx=1\n';
  assert.deepEqual(validateB3PluginIni(ini), { ok: true });
});

test('ini: option before any section fails on line 1', () => {
  assert.deepEqual(validateB3PluginIni('k = v\n[a]\n'), { ok: false, line: 1 });
});

test('ini: broken section header fails with its line', () => {
  assert.deepEqual(validateB3PluginIni('[a]\nk = v\n[broken\n'), { ok: false, line: 3 });
});

test('xml: accepted document', () => {
  const xml = '<?xml version="1.0"?>\n<!-- c -->\n<configuration><settings name="a"><set name="b">1</set></settings></configuration>\n';
  assert.deepEqual(validateB3PluginXml(xml), { ok: true });
});

test('xml: failures report the line', () => {
  assert.deepEqual(validateB3PluginXml('<configuration>\n<a>\n</configuration>'), { ok: false, line: 3 });
  assert.deepEqual(validateB3PluginXml('<configuration>\n<a></b>\n</configuration>'), { ok: false, line: 2 });
  assert.deepEqual(validateB3PluginXml('<configuration>\n<a>\n'), { ok: false, line: 3 });
  assert.deepEqual(validateB3PluginXml('<settings>\n</settings>'), { ok: false, line: 1 });
  assert.deepEqual(validateB3PluginXml('<configuration>\n<a name=x/>\n</configuration>'), { ok: false, line: 2 });
});

test('code: validation rejects bad input', () => {
  const good = 'class MyplugPlugin(b3.plugin.Plugin):\n    pass\n';
  assert.doesNotThrow(() => validateB3PluginCode('myplug', good));
  const codeOf = fn => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(codeOf(() => validateB3PluginCode('myplug', 'class Other(object):\n    pass\n')), 'B3_PLUGIN_CODE_INVALID');
  assert.equal(codeOf(() => validateB3PluginCode('myplug', `${good}\0`)), 'B3_PLUGIN_CODE_INVALID');
  assert.equal(codeOf(() => validateB3PluginCode('myplug', `${good}#${'x'.repeat(256 * 1024)}`)), 'B3_PLUGIN_CODE_INVALID');
});

test('text check: config default code, invalid UTF-8 and NUL', () => {
  const codeOf = fn => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(codeOf(() => checkB3PluginText('ok')), null);
  assert.equal(codeOf(() => checkB3PluginText('a\0b')), 'B3_PLUGIN_CONFIG_INVALID');
  assert.equal(codeOf(() => checkB3PluginText('x'.repeat(256 * 1024 + 1))), 'B3_PLUGIN_CONFIG_INVALID');
  assert.equal(codeOf(() => checkB3PluginText(Buffer.from([0xc3, 0x28]))), 'B3_PLUGIN_CONFIG_INVALID');
  assert.equal(codeOf(() => checkB3PluginText(Buffer.from([0xc3, 0x28]), 'B3_PLUGIN_CODE_INVALID')), 'B3_PLUGIN_CODE_INVALID');
});

test('messages: every code has German and English text', () => {
  const codes = ['B3_PLUGIN_MISSING', 'B3_PLUGIN_INTEGRITY_FAILED', 'B3_PLUGIN_NOT_APPROVED', 'B3_PLUGIN_DEPENDENCY_MISSING',
    'B3_PLUGIN_REQUIRES_PLUGIN', 'B3_PLUGIN_CONFIG_MISSING', 'B3_PLUGIN_CONFIG_INVALID', 'B3_PLUGIN_CODE_INVALID',
    'B3_PLUGIN_CONFLICT', 'B3_PLUGIN_NAME_INVALID', 'B3_PLUGIN_FIXED', 'B3_PLUGIN_UNKNOWN', 'B3_PLUGIN_LIMIT',
    'B3_PLUGIN_REGISTRY_INVALID', 'PLUGINS_CHANGED'];
  for (const code of codes) {
    const [de, en] = B3_PLUGIN_MESSAGES[code] ?? [];
    assert.ok(de && en, code);
    assert.equal(b3PluginMessage(code, 'en'), en);
    assert.equal(b3PluginMessage(code), de);
  }
  assert.equal(b3PluginMessage('NOPE'), 'NOPE');
});

test('validateB3PluginCode matches the class line without a name-built RegExp (CodeQL)', () => {
  assert.doesNotThrow(() => validateB3PluginCode('myplug', 'import b3\r\nclass MyplugPlugin(b3.plugin.Plugin):\r\n    pass\r\n'));
  assert.doesNotThrow(() => validateB3PluginCode('myplug', 'class MyplugPlugin:\n    pass\n'));
  assert.throws(() => validateB3PluginCode('myplug', 'class MyplugPluginX(object):\n    pass\n'), { code: 'B3_PLUGIN_CODE_INVALID' });
  assert.throws(() => validateB3PluginCode('myplug', '  class MyplugPlugin(object):\n'), { code: 'B3_PLUGIN_CODE_INVALID' });
});
