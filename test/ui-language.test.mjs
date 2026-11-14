import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { MENU_LABELS, MENU_GUIDE, QUICK_START } from '../lib/overview-guide.mjs';

// 4.18.31: English is the default UI language, German stays selectable and is remembered; the overview
// explains every menu item in both languages; the Remote Linux page uses the shared look.
const source = fileURLToPath(new URL('../', import.meta.url));
const ui = readFileSync(new URL('../cod4x-control-improved.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const skip = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url)) ? false : 'native esbuild missing';

async function load(entry, exportsLine) {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; ${entry} export const render = (C, props) => renderToStaticMarkup(React.createElement(C, props)); ${exportsLine}`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}

test('every menu item has a label and a description in German and English, and the quick start has both languages', () => {
  const tabLine = ui.match(/const TABS=\[(.*)\];/)[1];
  const ids = [...tabLine.matchAll(/\["([a-z]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 12);
  assert.deepEqual(MENU_GUIDE.map(([id]) => id), ids, 'one description per menu item, in menu order');
  for (const id of ids) assert.ok(MENU_LABELS[id]?.[0] && MENU_LABELS[id]?.[1], `label ${id}`);
  for (const [id, german, english] of MENU_GUIDE) { assert.ok(german.length > 20 && english.length > 20, id); assert.notEqual(german, english, id); }
  assert.ok(QUICK_START.length >= 5);
  for (const [german, english] of QUICK_START) { assert.ok(german && english); assert.notEqual(german, english); }
});

test('English is the default and the choice is stored; the old German default is gone', () => {
  assert.match(ui, /export const UI_LANG_KEY="cod4x\.ui\.lang"/);
  assert.match(ui, /localStorage\.getItem\(UI_LANG_KEY\)==="de"\?"de":"en"/);
  assert.match(ui, /localStorage\.setItem\(UI_LANG_KEY,next\)/);
  assert.doesNotMatch(ui, /\[lang,setLang\]=useState\("de"\)/);
  assert.match(ui, /DE · Deutsch/);
});

test('readUiLang falls back to English and keeps German only when stored', { skip }, async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  try {
    const m = await load(`import { readUiLang, UI_LANG_KEY } from './cod4x-control-improved.jsx';`, 'export { readUiLang, UI_LANG_KEY };');
    assert.equal(m.readUiLang(), 'en');
    store.set(m.UI_LANG_KEY, 'de'); assert.equal(m.readUiLang(), 'de');
    store.set(m.UI_LANG_KEY, 'fr'); assert.equal(m.readUiLang(), 'en');
    globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
    assert.equal(m.readUiLang(), 'en');
  } finally { delete globalThis.localStorage; }
});

test('the app opens on the overview with guide and menu cards in English by default and in German on request', { skip }, async () => {
  const m = await load(`import { ControlApp } from './cod4x-control-improved.jsx';`, 'export { ControlApp };');
  const user = { username: 'rafiki', role: 'admin' };
  const en = m.render(m.ControlApp, { user, onLogout() {} });
  const de = m.render(m.ControlApp, { user, onLogout() {}, lang: 'de' });
  assert.match(en, /Quick start: step by step/);
  assert.match(en, /Menu items at a glance/);
  assert.match(en, /Diagnostics/);
  assert.match(en, />Logout</);
  assert.doesNotMatch(en, /Schnellstart|Übersicht/);
  assert.match(de, /Schnellstart: Schritt für Schritt/);
  assert.match(de, /Menüpunkte im Überblick/);
  assert.match(de, />Abmelden</);
  for (const [, , english] of MENU_GUIDE) assert.ok(en.includes(english.replace(/"/g, '&quot;')), english);
});

test('Remote Linux uses the shared cards, fields and buttons in both languages, without raw inline layout', { skip }, async () => {
  const m = await load(`import { RemoteHostsPanel } from './lib/remote-hosts.jsx';`, 'export { RemoteHostsPanel };');
  const noFetch = () => { throw new Error('SSR must not fetch'); };
  for (const de of [false, true]) {
    const html = m.render(m.RemoteHostsPanel, { de, request: noFetch });
    assert.equal((html.match(/class="rl-card"/g) || []).length, 4);
    assert.match(html, /class="rl-grid"/);
    assert.match(html, /class="rl-field"/);
    assert.match(html, /class="rl-primary"/);
    assert.doesNotMatch(html, /<h3>Remote Linux<\/h3>/);
  }
  const source = readFileSync(new URL('../lib/remote-hosts.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /border: '1px solid currentColor'/);
  for (const rule of ['.remote-linux .rl-card{', '.remote-linux .rl-grid{', '.remote-linux button:not([style]){', '.remote-linux input[type="text"]']) assert.ok(css.includes(rule), rule);
});
