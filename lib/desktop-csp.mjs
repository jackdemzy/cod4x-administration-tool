// Security audit 4.18.26 (A6-2): Content-Security-Policy of the desktop renderer.
// Only the built page gets it (vite.config.js); the Vite dev server injects inline
// scripts for hot reload. The renderer talks to the local backend and, for the
// version check, to the GitHub API; nothing else.
export const DESKTOP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  'connect-src http://127.0.0.1:8787 https://api.github.com',
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export function withDesktopCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${DESKTOP_CSP}">`;
  if (!/<head>/i.test(html) || /Content-Security-Policy/i.test(html)) throw new Error('CSP_INJECTION_FAILED');
  return html.replace(/<head>/i, `<head>${meta}`);
}
