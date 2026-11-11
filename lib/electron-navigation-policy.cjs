'use strict';
const { fileURLToPath } = require('url');
const path = require('path');

// Security audit 4.18.26 (A6-1): what an Electron window of COD4X CONTROL may show, open and
// send. Pure functions so the rules are tested without Electron.

// True only for the app's own file:// page (any #fragment or ?query of it).
function isAppPage(url, appIndexPath) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    const parsed = new URL(url);
    parsed.hash = ''; parsed.search = '';
    return path.resolve(fileURLToPath(parsed.href)) === path.resolve(appIndexPath);
  } catch { return false; }
}

// Links leave the app only as https, and only to the system browser.
function externalUrlAllowed(url) {
  try { return new URL(String(url)).protocol === 'https:'; } catch { return false; }
}

// The per-launch desktop header only for requests of the main window's top frame showing the
// app page; never for another window, a child frame or a page the window navigated to.
function desktopHeaderAllowed(details, mainWebContentsId, appIndexPath) {
  if (!details || typeof details.webContentsId !== 'number' || details.webContentsId !== mainWebContentsId) return false;
  const frame = details.frame;
  if (!frame) return false;
  return !frame.parent && isAppPage(frame.url, appIndexPath);
}

module.exports = { isAppPage, externalUrlAllowed, desktopHeaderAllowed };
