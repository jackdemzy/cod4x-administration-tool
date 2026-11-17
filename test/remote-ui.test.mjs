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
const appCode0 = () => readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
const noFetch = () => { throw new Error('SSR must not fetch'); };

test('remote app: login page with the AGPL source link, dashboard after login, no password storage', { skip }, async () => {
  const { render, helpers } = await renderer();
  const info = { version: '4.18.16', sourceUrl: 'https://github.com/jackdemzy/cod4x-administration-tool' };
  const login = render('RemoteApp', { initialInfo: info });
  assert.ok(login.includes('COD4X CONTROL 4.18.16') && login.includes('href="https://github.com/jackdemzy/cod4x-administration-tool"') && login.includes('Source code (AGPL-3.0)'));
  const form = render('RemoteLogin', { onLogin() {}, setLang() {} });
  assert.ok(form.includes('Username<') && form.includes('>Log in<') && /aria-pressed="true"[^>]*>EN</.test(form) && /aria-pressed="false"[^>]*>DE</.test(form), 'English login with the EN/DE switch');
  const formDe = render('RemoteLogin', { onLogin() {}, setLang() {}, de: true, initialError: { code: 'REMOTE_LOGIN_REQUIRED' } });
  assert.ok(formDe.includes('Sitzung abgelaufen. Bitte neu anmelden.'), 'the stored error code is translated while rendering');
  assert.ok(render('RemoteLogin', { onLogin() {}, initialError: { code: 'REMOTE_LOGIN_REQUIRED' } }).includes('Session expired. Please log in again.'), 'same error, English after a switch');
  assert.equal(helpers.failureText({ push: { name: 'AbortError', message: 'x' } }), 'Push registration failed (AbortError: x).');
  assert.equal(helpers.failureText({ push: { name: 'AbortError' } }, true), 'Push-Anmeldung fehlgeschlagen (AbortError).');
  assert.equal(helpers.failureText({ code: undefined }), 'Unknown error.', 'a network error without code still shows a message');
  assert.equal(helpers.failureText(null), '');
  assert.ok(formDe.includes('Benutzername<') && formDe.includes('>Anmelden<') && /aria-pressed="true"[^>]*>DE</.test(formDe));
  const loggedIn = render('RemoteApp', { initialInfo: info, initialSession: { user: { username: 'phone', role: 'viewer' }, monitor: true } });
  assert.ok(loggedIn.includes('phone') && loggedIn.includes('Log out') && loggedIn.includes('First poll running'));
  assert.ok(loggedIn.includes('Source code (AGPL-3.0)'), 'source link after login too');
  const german = render('RemoteApp', { initialInfo: info, initialLang: 'de', initialSession: { user: { username: 'phone', role: 'viewer' }, monitor: true } });
  assert.ok(german.includes('Abmelden') && german.includes('Erste Abfrage läuft') && german.includes('Quellcode (AGPL-3.0)'), 'German stays selectable');
  assert.ok(!/Abmelden|Quellcode|Erste Abfrage/.test(loggedIn), 'no German text in the English view');
  assert.doesNotMatch(appCode0(), /setError\(remoteMessage|setNotice\(L\(|error: remoteMessage/, 'no translated text is kept in state');
  const appCode = readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
  assert.match(appCode, /document\.documentElement\.lang = lang; \}, \[lang\]\)/, '<html lang> follows a restored German choice');
  assert.match(loggedIn, /<header style="display:flex;flex-wrap:wrap/, 'the header wraps on narrow phones');
  assert.equal(helpers.remoteRoute('/api/monitor/instances/a/history?range=7d'), '/remote/api/monitor/instances/a/history?range=7d');
  assert.equal(helpers.remoteMessage('REMOTE_LOGIN_LOCKED'), 'Too many failed attempts. Please try again later.');
  assert.equal(helpers.remoteMessage('REMOTE_LOGIN_LOCKED', true), 'Zu viele Fehlversuche. Bitte später erneut versuchen.');
  assert.equal(helpers.remoteMessage('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.equal(helpers.remoteMessage('constructor'), 'constructor', 'no prototype lookups');
  assert.equal(helpers.remoteMessage(undefined), 'Unknown error.');
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

test('notifications panel, proxy mode and push toggle (Block 24c)', { skip }, async () => {
  const { render } = await renderer();
  const alerts = { rules: { enabled: true, onDown: true, onUp: true, onPlannedStop: false, diskFreeGb: 5, b3Stopped: false, playersAtLeast: null, repeatMinutes: 30 },
    discord: { configured: true, url: 'https://discord.com/api/webhooks/1234…/••••abcd', last: { at: Date.UTC(2026, 10, 5, 12), ok: true, code: null } },
    push: { enabled: true, subscriptions: 2, users: ['phone'], last: null } };
  const html = render('NotificationsSection', { de: true, request: noFetch, initial: alerts });
  for (const text of ['Benachrichtigungen', 'Alarme eingeschaltet', 'https://discord.com/api/webhooks/1234…/••••abcd', 'Entfernen', 'Push senden · 2 Gerät(e) (phone)', 'Testalarm senden', 'iOS 16.4', 'Sperrzeit (min)']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('type="password"') && !html.includes('value="https://discord.com/api/webhooks/1234'), 'the webhook field never shows a URL');
  const remote = { settings: { enabled: true, mode: 'proxy', port: 8788, lanHost: null, certFile: null, keyFile: null, proxyDomain: 'monitor.example.org' }, running: true, error: null, address: { host: '127.0.0.1', port: 8788 }, appBuilt: true,
    tailscaleCommand: 'x', tailscaleOffCommand: 'y', caddyfile: 'monitor.example.org {\n\treverse_proxy 127.0.0.1:8788\n}\n', proxyLoginLimit: 5, sessions: [] };
  const gateway = render('GatewaySection', { de: true, request: noFetch, initial: remote });
  for (const text of ['Öffentliche Domain hinter Caddy', 'Zweiter Faktor ist für alle Rollen Pflicht, nach 5 Fehlversuchen', 'monitor.example.org {', 'Let&#x27;s Encrypt']) assert.ok(gateway.includes(text), text);
  assert.equal(render('PushToggle', {}), '', 'nothing before the browser is checked (SSR)');
  const code = readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
  assert.ok(code.includes("userVisibleOnly: true") && code.includes("'/remote/api/push/subscribe'"));
  const sw = readFileSync(new URL('../remote-public/sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes('addEventListener("push"') && sw.includes('showNotification') && sw.includes('notificationclick'));
});

test('remote app: actions panel only when allowed, code field until the step-up, restart asks again', { skip }, async () => {
  const { render, helpers } = await renderer();
  assert.equal(render('ActionsPanel', { initial: { allowed: false } }), '');
  const servers = [{ id: 'a', name: 'Gate', up: true, players: 3 }, { id: 'b', name: 'Down', up: false, players: 0 }];
  const fresh = render('ActionsPanel', { initial: { allowed: true, stepUpUntil: null, servers } });
  assert.ok(fresh.includes('Actions') && fresh.includes('Gate') && fresh.includes('3 players') && fresh.includes('Every action needs a fresh code'));
  assert.equal((fresh.match(/>Restart<\/button>/g) || []).length, 2);
  assert.equal((fresh.match(/<button[^>]*disabled=""[^>]*>Message/g) || []).length, 1, 'no message to a server that is down');
  const stepped = render('ActionsPanel', { initial: { allowed: true, stepUpUntil: Date.now() + 60e3, servers } });
  assert.ok(stepped.includes('Confirmed until') && stepped.includes('A restart still asks for a code'));
  const freshDe = render('ActionsPanel', { de: true, initial: { allowed: true, stepUpUntil: null, servers } });
  assert.ok(freshDe.includes('Aktionen') && freshDe.includes('3 Spieler') && freshDe.includes('Jede Aktion braucht einen frischen Code'));
  assert.equal((freshDe.match(/>Neustart<\/button>/g) || []).length, 2);
  const steppedDe = render('ActionsPanel', { de: true, initial: { allowed: true, stepUpUntil: Date.now() + 60e3, servers } });
  assert.ok(steppedDe.includes('Bestätigt bis') && steppedDe.includes('Ein Neustart fragt trotzdem nach einem Code'));
  for (const code of ['REMOTE_STEP_UP_REQUIRED', 'REMOTE_STEP_UP_INVALID', 'REMOTE_ACTION_LIMIT', 'REMOTE_RESTART_COOLDOWN', 'REMOTE_ACTIONS_DISABLED', 'RCON_SAY_INVALID']) assert.notEqual(helpers.remoteMessage(code), code, code);
  const code = readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
  assert.ok(!/\/rcon\/|\/stop|\/start/.test(code), 'no free RCON, start or stop from the phone');
});

test('remote app: English by default, German selectable and remembered; page, manifest and every message in both languages', async () => {
  const { readRemoteLang, storeRemoteLang, REMOTE_LANG_KEY } = await import('../lib/remote-lang.mjs');
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  try {
    assert.equal(readRemoteLang(), 'en');
    assert.equal(storeRemoteLang('de'), 'de'); assert.equal(store.get(REMOTE_LANG_KEY), 'de'); assert.equal(readRemoteLang(), 'de');
    assert.equal(storeRemoteLang('fr'), 'en'); assert.equal(readRemoteLang(), 'en');
    assert.deepEqual([...store.keys()], [REMOTE_LANG_KEY], 'only the language is stored, never the session');
    globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readRemoteLang(), 'en'); assert.equal(storeRemoteLang('de'), 'de');
  } finally { delete globalThis.localStorage; }
  const html = readFileSync(new URL('../remote.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/);
  const manifest = JSON.parse(readFileSync(new URL('../remote-public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.lang, 'en');
  assert.doesNotMatch(manifest.description, /[äöüß]|Spieler|Ausfälle/);
  const code = readFileSync(new URL('../lib/remote-app.jsx', import.meta.url), 'utf8');
  const table = code.slice(code.indexOf('const MESSAGES = {'), code.indexOf('};', code.indexOf('const MESSAGES = {')));
  const rows = [...table.matchAll(/^\s+([A-Z_]+): \['(.*)', '(.*)'\],$/gm)];
  assert.ok(rows.length >= 26, `message rows: ${rows.length}`);
  for (const [, key, german, english] of rows) { assert.ok(german && english, key); assert.notEqual(german, english, key); assert.doesNotMatch(english, /[äöüÄÖÜß]/, key); }
  // Outside the [German, English] pairs no German text is left in the remote app.
  const rest = code.replace(/^\s+[A-Z_]+: \[.*\],$/gm, '').replace(/L\(de, ('[^']*'|`[^`]*`), /g, 'L(de, X, ');
  assert.doesNotMatch(rest.replace(/^\s*\/\/.*$/gm, ''), /[äöüÄÖÜß]|\b(Abmelden|Anmelden|Nachricht|Neustart|Spieler|Kicken|Senden)\b/);
});
