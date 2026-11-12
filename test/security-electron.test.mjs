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
