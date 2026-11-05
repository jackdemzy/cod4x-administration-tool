import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function renderer() {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import * as app from './lib/remote-app.jsx'; import * as panel from './lib/remote-access-panel.jsx'; const view = {...app, ...panel}; export const render = (name, props) => renderToStaticMarkup(React.createElement(view[name], props)); export const helpers = view;`, resolveDir: source, loader: 'jsx' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: `import {createRequire as testCreateRequire} from 'node:module'; const require = testCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` },
  });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}
const nativeCompilerAvailable = process.platform === 'win32' || existsSync(new URL('../node_modules/@esbuild/linux-x64/bin/esbuild', import.meta.url));
const skip = nativeCompilerAvailable ? false : 'Shared Windows dependencies do not contain native Linux esbuild; UI renderer verified on Windows separately';
const noFetch = () => { throw new Error('SSR must not fetch'); };

test('remote app: login page with the AGPL source link, dashboard after login, no password storage', { skip }, async () => {
  const { render, helpers } = await renderer();
  const info = { version: '4.18.16', sourceUrl: 'https://github.com/jackdemzy/cod4x-administration-tool' };
  const login = render('RemoteApp', { initialInfo: info });
  assert.ok(login.includes('COD4X CONTROL 4.18.16') && login.includes('href="https://github.com/jackdemzy/cod4x-administration-tool"') && login.includes('Quellcode (AGPL-3.0)'));
  const loggedIn = render('RemoteApp', { initialInfo: info, initialSession: { user: { username: 'phone', role: 'viewer' }, monitor: true } });
  assert.ok(loggedIn.includes('phone') && loggedIn.includes('Abmelden') && loggedIn.includes('Erste Abfrage läuft'));
  assert.ok(loggedIn.includes('Quellcode (AGPL-3.0)'), 'source link after login too');
  assert.equal(helpers.remoteRoute('/api/monitor/instances/a/history?range=7d'), '/remote/api/monitor/instances/a/history?range=7d');
  assert.equal(helpers.remoteMessage('REMOTE_LOGIN_LOCKED'), 'Zu viele Fehlversuche. Bitte später erneut versuchen.');
  const code = readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
  assert.ok(!/localStorage|sessionStorage/.test(code), 'the session stays in the HttpOnly cookie');
  assert.ok(!/<button[^>]*>(Kick|Neustart|Restart|Stop)/i.test(loggedIn), 'read-only');
});

test('remote access panel: TOTP setup, gateway settings and sessions', { skip }, async () => {
  const { render } = await renderer();
  const remote = { settings: { enabled: true, mode: 'tailscale', port: 8788, lanHost: null, certFile: null, keyFile: null }, running: true, error: null, address: { host: '127.0.0.1', port: 8788 }, appBuilt: true,
    tailscaleCommand: 'tailscale serve --bg --https=443 127.0.0.1:8788', tailscaleOffCommand: 'tailscale serve --https=443 127.0.0.1:8788 off',
    sessions: [{ sessionId: 's1', username: 'phone', role: 'viewer', mfa: true, client: '100.64.0.2', tailscaleUser: 'rafiki@example.com', lastSeenAt: Date.UTC(2026, 10, 5, 12) }] };
  const gateway = render('GatewaySection', { de: true, request: noFetch, initial: remote });
  for (const text of ['Läuft auf 127.0.0.1:8788', 'tailscale serve --bg --https=443 127.0.0.1:8788', 'Aktive Fern-Sitzungen (1)', 'rafiki@example.com', '2FA', 'Beenden', 'Tailscale (empfohlen)']) assert.ok(gateway.includes(text), text);
  const notSet = render('SecondFactorSection', { de: true, request: noFetch, me: { totpEnabled: false } });
  assert.ok(notSet.includes('Einrichten') && notSet.includes('Pflicht für Fernzugriff'));
  const set = render('SecondFactorSection', { de: true, request: noFetch, me: { totpEnabled: true, recoveryRemaining: 7 } });
  assert.ok(set.includes('7 Wiederherstellungscodes übrig') && set.includes('Ausschalten') && set.includes('type="password"'));
});
