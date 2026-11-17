// The remote web app speaks English by default; German stays selectable (EN/DE
// in the header and on the login page). Only this choice is kept in the
// browser's localStorage, under the same key the desktop app uses. The login
// session itself never touches web storage (HttpOnly cookie only).
export const REMOTE_LANG_KEY = 'cod4x.ui.lang';

export function readRemoteLang() {
  try { return globalThis.localStorage?.getItem(REMOTE_LANG_KEY) === 'de' ? 'de' : 'en'; } catch { return 'en'; }
}

export function storeRemoteLang(value) {
  const next = value === 'de' ? 'de' : 'en';
  try { globalThis.localStorage?.setItem(REMOTE_LANG_KEY, next); } catch {}
  try { if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = next; } catch {}
  return next;
}
