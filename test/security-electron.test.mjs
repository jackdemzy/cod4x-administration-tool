import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Security audit 4.18.26, area 6, finding A6-1: a link opened a new Electron window that could
// browse to any site; the desktop header (A5-1) went with every request to 127.0.0.1:8787 from
// any window or frame, so a hostile page there passed the backend's Origin check.
const require = createRequire(import.meta.url);
const policy = require('../lib/electron-navigation-policy.cjs');
const index = path.resolve('dist', 'index.html');
const app = pathToFileURL(index).href;

test('A6-1: only the app page itself may be shown in the window', () => {
  assert.equal(policy.isAppPage(app, index), true);
  assert.equal(policy.isAppPage(`${app}#/servers`, index), true);
  for (const url of ['https://github.com/x', 'http://127.0.0.1:8787/api/x', pathToFileURL(path.resolve('dist', 'other.html')).href, 'file:///etc/passwd', 'otpauth://totp/x', 'javascript:alert(1)', '', null]) assert.equal(policy.isAppPage(url, index), false, String(url));
});

test('A6-1: new windows are never opened; only https links go to the system browser', () => {
  assert.equal(policy.externalUrlAllowed('https://github.com/x/releases/tag/v1'), true);
  for (const url of ['http://example.org', 'file:///C:/x.exe', 'smb://host/share', 'javascript:alert(1)', 'otpauth://totp/x', 'ms-msdt:/id', '']) assert.equal(policy.externalUrlAllowed(url), false, url);
});

test('A6-1: the desktop header goes only with requests of the main window\'s app page', () => {
  const frame = { url: app, parent: null };
  assert.equal(policy.desktopHeaderAllowed({ webContentsId: 7, frame }, 7, index), true);
  assert.equal(policy.desktopHeaderAllowed({ webContentsId: 8, frame }, 7, index), false, 'another window');
  assert.equal(policy.desktopHeaderAllowed({ webContentsId: 7, frame: { url: 'about:srcdoc', parent: frame } }, 7, index), false, 'a frame inside the page');
  assert.equal(policy.desktopHeaderAllowed({ webContentsId: 7, frame: { url: 'https://evil.example/', parent: null } }, 7, index), false, 'the window navigated away');
  assert.equal(policy.desktopHeaderAllowed({ webContentsId: undefined }, 7, index), false);
});

test('A6-1: electron-main wires the policy into every window, the header hook and the IPC handlers', async () => {
  const main = await fs.readFile(new URL('../electron-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /web-contents-created/);
  assert.match(main, /setWindowOpenHandler\([^)]*\)\s*=>[\s\S]*?action:\s*'deny'/);
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) assert.ok(main.includes(`'${event}'`), event);
  assert.match(main, /desktopHeaderAllowed\(details,/);
  assert.ok(!/ipcMain\.handle\(/.test(main.replace(/function handle\([\s\S]*?\n\}/, '')), 'every IPC handler goes through the sender check');
});

test('A6-3: only clipboard writes of the app page in the main window are granted', () => {
  assert.equal(policy.permissionAllowed({ permission: 'clipboard-sanitized-write', webContentsId: 7, url: app }, 7, index), true);
  for (const permission of ['notifications', 'media', 'geolocation', 'openExternal', 'clipboard-read', 'fullscreen', 'hid', 'serial', 'usb']) assert.equal(policy.permissionAllowed({ permission, webContentsId: 7, url: app }, 7, index), false, permission);
  assert.equal(policy.permissionAllowed({ permission: 'clipboard-sanitized-write', webContentsId: 8, url: app }, 7, index), false, 'another window');
  assert.equal(policy.permissionAllowed({ permission: 'clipboard-sanitized-write', webContentsId: 7, url: 'https://evil.example/' }, 7, index), false, 'another page');
});

test('A6-3, A6-4: electron-main wires the permission handlers and the remembered-login rules', async () => {
  const main = await fs.readFile(new URL('../electron-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /setPermissionRequestHandler\(/);
  assert.match(main, /setPermissionCheckHandler\(/);
  assert.match(main, /permissionAllowed\(/);
  assert.match(main, /mode:\s*0o600/);
  assert.match(main, /rememberedLoginBackendAllowed\(process\.platform/);
});

test('A6-4: no remembered login with the fixed-key backend on Linux', () => {
  assert.equal(policy.rememberedLoginBackendAllowed('linux', 'basic_text'), false);
  assert.equal(policy.rememberedLoginBackendAllowed('linux', 'unknown'), false);
  assert.equal(policy.rememberedLoginBackendAllowed('linux', undefined), false);
  assert.equal(policy.rememberedLoginBackendAllowed('linux', 'gnome_libsecret'), true);
  assert.equal(policy.rememberedLoginBackendAllowed('win32', undefined), true);
});

test('A6-2: the built desktop page carries a strict CSP', async () => {
  const { DESKTOP_CSP, withDesktopCsp } = await import('../lib/desktop-csp.mjs');
  for (const directive of ["default-src 'none'", "script-src 'self'", 'connect-src http://127.0.0.1:8787 https://api.github.com', "object-src 'none'"]) assert.ok(DESKTOP_CSP.includes(directive), directive);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(DESKTOP_CSP));
  const html = withDesktopCsp('<!doctype html><html><head><title>x</title></head></html>');
  assert.ok(html.includes('<head><meta http-equiv="Content-Security-Policy"'));
  assert.throws(() => withDesktopCsp(html), /CSP_INJECTION_FAILED/);
  assert.match(await fs.readFile(new URL('../vite.config.js', import.meta.url), 'utf8'), /withDesktopCsp/);
});

test('A6-5: the advisories document lists every production dependency', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const doc = await fs.readFile(new URL('../docs/SECURITY-ADVISORIES.md', import.meta.url), 'utf8');
  for (const name of Object.keys(pkg.dependencies)) assert.ok(doc.includes(`\`${name}\``), name);
});
