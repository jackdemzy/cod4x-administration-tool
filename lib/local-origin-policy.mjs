import crypto from 'node:crypto';

// Security audit 4.18.26 (A5-1, A5-2): which browser pages may talk to the admin API on
// 127.0.0.1:8787. Requests without an Origin header come from scripts, tests and
// Electron's main process and are judged by the bearer token as before. A browser page
// is allowed only when it is one of ours:
//  - the desktop renderer (file://, so Origin "null") together with the per-launch
//    secret header Electron's main process adds; a sandboxed iframe of a foreign page
//    also sends Origin "null" but cannot know the secret,
//  - the Vite dev server,
//  - pages the backend serves itself (its own origin).
// Everything else, including a DNS-rebound page, is refused before any route runs.

export const DESKTOP_CLIENT_HEADER = 'x-cod4x-desktop';
export const DEV_ORIGINS = Object.freeze(['http://localhost:5173', 'http://127.0.0.1:5173']);

const TOKEN = /^[0-9a-f]{64}$/;

export function validDesktopToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function sameSecret(a, b) {
  if (!validDesktopToken(a) || !validDesktopToken(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Returns { allowed, allowOrigin }: allowOrigin is the value for
// Access-Control-Allow-Origin, or null when no CORS grant is given.
export function localOriginDecision({ origin, desktopHeader, desktopToken, ownOrigins = [], preflight = false }) {
  if (origin === undefined || origin === null || origin === '') return { allowed: true, allowOrigin: null };
  const value = String(origin);
  if (DEV_ORIGINS.includes(value) || ownOrigins.includes(value)) return { allowed: true, allowOrigin: value };
  if (value === 'null') {
    // A CORS preflight never carries the secret; the actual request is checked below.
    if (preflight) return { allowed: validDesktopToken(desktopToken), allowOrigin: validDesktopToken(desktopToken) ? 'null' : null };
    const allowed = sameSecret(String(desktopHeader || ''), desktopToken);
    return { allowed, allowOrigin: allowed ? 'null' : null };
  }
  return { allowed: false, allowOrigin: null };
}
