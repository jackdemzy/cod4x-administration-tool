import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { evaluateB3Dependencies } from '../lib/b3-dependencies.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/b3-dependency-panel.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props));`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).render;
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
test('B3 dependency panel shows the matrix, blocking state and blocked SQL without fetching', {
  skip: nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately',
}, async () => {
  const render = await renderer();
  const modules = Object.fromEntries(['dateutil', 'pymysql', 'mysql.connector', 'MySQLdb', 'feedparser', 'requests', 'paramiko', 'psycopg2'].map(name => [name, { ok: name === 'dateutil', version: null }]));
  const dependencies = { ...evaluateB3Dependencies({ python: { version: '3.11.5', major: 3, minor: 11, bits: 64, modules }, source: { b3Version: '1.10.10', complete: true, audited: true, authPlugin: true, destructiveSql: [] } }), python: { version: '3.11.5', bits: 64 } };
  const html = render('B3DependencyTable', { de: true, dependencies });
  assert.match(html, /role="alert"><strong>BLOCKED<\/strong>/);
  assert.match(html, /Python: 3\.11\.5/);
  assert.match(html, /INCOMPATIBLE – inkompatibel \(PYTHON_INCOMPATIBLE\)/);
  assert.match(html, /UNVERIFIED – nur nativ prüfbar/);
  assert.match(html, /b3-update-ebc\.sql/);
  assert.match(html, /90966246ab19/);
  const panel = render('B3DependencyPanel', { de: false, request: () => { throw new Error('SSR must not fetch'); } });
  assert.match(panel, /does not start B3 here/);
});
