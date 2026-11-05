import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as view from './lib/monitor-dashboard.jsx'; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props)); export const helpers = view;`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}

const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const noFetch = () => { throw new Error('SSR must not fetch'); };
const now = Date.UTC(2026, 10, 5, 12);
const monitor = { checkedAt: now, intervalMs: 15000, host: { cpuPercent: 12.5, cpuCount: 8, memory: { usedPercent: 40 }, disks: [{ path: '/srv', freeBytes: 50e9, totalBytes: 200e9 }] }, instances: [
  { id: 'a', name: 'Alpha', port: 28960, status: 'RUNNING', up: true, latencyMs: 3, hostname: 'Alpha Host', map: 'mp_crash', gametype: 'war', players: [{ name: 'Wolf', score: 12, ping: 48 }], maxClients: 18, startedAt: new Date(now - 2 * 3600e3).toISOString(), checkedAt: now, b3: true, down: false },
  { id: 'b', name: 'Bravo', port: 28961, status: 'FAILED', up: false, latencyMs: null, players: [], maxClients: null, startedAt: null, checkedAt: now, b3: null, down: true },
] };

test('dashboard shows each server with state, map, players and host load', { skip }, async () => {
  const { render } = await renderer();
  const html = render('MonitorDashboard', { de: true, request: noFetch, initial: monitor });
  for (const text of ['Alpha', 'Alpha Host', 'mp_crash · war', '1 / 18', '3 ms', 'Wolf', 'Online', 'Bravo', 'Abgestürzt', '12.5 %', '50.0 GB / 200.0 GB', '2 h 00']) assert.ok(html.includes(text), text);
  assert.ok(!/<button[^>]*>(Kicken|Kick)</.test(html), 'monitoring is read-only');
});

test('state labels and durations', { skip }, async () => {
  const { helpers } = await renderer();
  assert.equal(helpers.serverState({ up: false, status: 'RUNNING', down: false }).en, 'Starting / map change');
  assert.equal(helpers.serverState({ up: false, status: 'RUNNING', down: true }).de, 'Keine Antwort');
  assert.equal(helpers.serverState({ up: false, status: 'STOPPED' }).de, 'Gestoppt');
  assert.deepEqual([helpers.duration(30e3), helpers.duration(30 * 60e3), helpers.duration(3 * 864e5, true)], ['30 s', '30 min', '3 Tage']);
});

test('history chart marks unanswered buckets and handles empty ranges', { skip }, async () => {
  const { render } = await renderer();
  const history = { start: now - 3600e3, end: now, points: [{ t: now - 3000e3, up: 1, players: 4 }, { t: now - 2000e3, up: 0, players: null }, { t: now - 1000e3, up: 1, players: 6 }] };
  const html = render('HistoryChart', { de: true, history });
  assert.match(html, /<path d="M/);
  assert.equal((html.match(/<rect /g) || []).length, 1);
  assert.match(render('HistoryChart', { de: true, history: { ...history, points: [] } }), /Noch keine Daten/);
});
