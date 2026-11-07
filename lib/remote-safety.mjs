import net from 'node:net';

// Block 18: the only place that turns untrusted values into something that may
// reach a remote shell or a remote path. Pure functions, no I/O.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };

// POSIX single quoting: nothing inside single quotes is interpreted by the shell.
export function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\u0000')) fail('REMOTE_ARGUMENT_INVALID');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 1024;

// Absolute, normalized POSIX path: no "..", ".", "//", control characters.
// A single trailing slash is dropped. With `under`, the path must lie strictly inside it.
export function assertRemotePosixPath(value, { under } = {}) {
  if (typeof value !== 'string' || value.length > MAX_PATH || CONTROL.test(value) || !value.startsWith('/')) fail('REMOTE_PATH_INVALID');
  const path = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (path === '/' || path.includes('//')) fail('REMOTE_PATH_INVALID');
  if (path.slice(1).split('/').some(segment => segment === '.' || segment === '..')) fail('REMOTE_PATH_INVALID');
  if (under !== undefined) {
    const root = assertRemotePosixPath(under);
    if (!path.startsWith(`${root}/`)) fail('REMOTE_PATH_INVALID');
  }
  return path;
}

export const validHostId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
export const validRemoteInstanceId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
// The core never runs as root, so a root login is refused when a host is saved.
export const validRemoteUser = value => typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value) && value !== 'root';

// DNS name or IP literal. A leading "-" or any shell/space character is refused,
// so a host name can never be read as an ssh option.
export function validHostName(value) {
  if (typeof value !== 'string' || !value || value.length > 253) return false;
  if (net.isIP(value)) return true;
  if (/^[0-9.]+$/.test(value) || value.includes(':')) return false; // a malformed IP literal
  return value.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
