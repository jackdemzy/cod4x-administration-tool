// Block 16b: syntax checks for B3 plugin config files (INI and XML) and plugin code text.
// These are cheap structural checks, not a full parse: they catch what would stop B3 from loading the file.
import { b3PluginClassName } from './b3-plugin-template.mjs';

export const MAX_B3_PLUGIN_TEXT_BYTES = 256 * 1024;

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code }, extra); };

// Shared text gate: size limit, NUL bytes and valid UTF-8. `text` is a string or a Buffer/Uint8Array.
export function checkB3PluginText(text, code = 'B3_PLUGIN_CONFIG_INVALID') {
  let str;
  if (typeof text === 'string') {
    if (typeof text.isWellFormed === 'function' && !text.isWellFormed()) fail(code);
    if (Buffer.byteLength(text, 'utf8') > MAX_B3_PLUGIN_TEXT_BYTES) fail(code);
    str = text;
  } else if (text instanceof Uint8Array) {
    if (text.byteLength > MAX_B3_PLUGIN_TEXT_BYTES) fail(code);
    try { str = new TextDecoder('utf-8', { fatal: true }).decode(text); } catch { fail(code); }
  } else {
    fail(code);
  }
  if (str.includes('\0')) fail(code);
}

// Python 2.7 ConfigParser line rules.
export function validateB3PluginIni(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  let inSection = false;
  let inOption = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const n = i + 1;
    const trimmed = line.trim();
    if (trimmed === '' || line[0] === '#' || line[0] === ';' || (line[0] === 'r' && /^rem(\s|$)/i.test(trimmed))) continue;
    if (/^\s/.test(line) && inSection && inOption) continue;
    if (/^\[[^\]]+\]/.test(line)) { inSection = true; inOption = false; continue; }
    if (!inSection) return { ok: false, line: n };
    if (/^[^:=\s][^:=]*[:=]/.test(line)) { inOption = true; continue; }
    return { ok: false, line: n };
  }
  return { ok: true };
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;

// Structural check only (no duplicate-attribute or entity validation).
// Small tokenizer with a tag stack: comments, PI, DOCTYPE, CDATA, quoted attributes, root must be <configuration>.
export function validateB3PluginXml(text) {
  const s = String(text);
  let pos = 0;
  let line = 1;
  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  const bad = () => ({ ok: false, line });
  const advance = to => {
    for (; pos < to; pos += 1) if (s[pos] === '\n') line += 1;
  };
  const skipPast = marker => {
    const at = s.indexOf(marker, pos);
    if (at === -1) return false;
    advance(at + marker.length);
    return true;
  };
  const readName = () => {
    if (!NAME_START.test(s[pos] ?? '')) return null;
    const start = pos;
    pos += 1;
    while (pos < s.length && NAME_CHAR.test(s[pos])) pos += 1;
    return s.slice(start, pos);
  };
  const skipSpace = () => { while (pos < s.length && /\s/.test(s[pos])) { if (s[pos] === '\n') line += 1; pos += 1; } };

  if (s.charCodeAt(0) === 0xfeff) pos = 1;
  while (pos < s.length) {
    if (s[pos] !== '<') {
      const next = s.indexOf('<', pos);
      const end = next === -1 ? s.length : next;
      const chunk = s.slice(pos, end);
      if (stack.length === 0 && chunk.trim() !== '') return bad();
      advance(end);
      continue;
    }
    if (s.startsWith('<!--', pos)) { advance(pos + 4); if (!skipPast('-->')) return bad(); continue; }
    if (s.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) return bad();
      advance(pos + 9);
      if (!skipPast(']]>')) return bad();
      continue;
    }
    if (s.startsWith('<?', pos)) { advance(pos + 2); if (!skipPast('?>')) return bad(); continue; }
    if (s.startsWith('<!DOCTYPE', pos)) {
      if (rootSeen) return bad();
      // Skip an optional internal subset in [...].
      let depth = 0;
      let p = pos + 9;
      while (p < s.length && !(s[p] === '>' && depth === 0)) {
        if (s[p] === '[') depth += 1;
        if (s[p] === ']') depth -= 1;
        p += 1;
      }
      if (p >= s.length) return bad();
      advance(p + 1);
      continue;
    }
    if (s.startsWith('</', pos)) {
      pos += 2;
      const name = readName();
      skipSpace();
      if (name === null || s[pos] !== '>') return bad();
      if (stack.pop() !== name) return bad();
      pos += 1;
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    // Start tag.
    pos += 1;
    const name = readName();
    if (name === null) return bad();
    if (stack.length === 0) {
      if (rootSeen || name !== 'configuration') return bad();
      rootSeen = true;
    }
    for (;;) {
      const before = pos;
      skipSpace();
      const c = s[pos];
      if (c === undefined) return bad();
      if (c === '>') { pos += 1; stack.push(name); break; }
      if (c === '/') {
        if (s[pos + 1] !== '>') return bad();
        pos += 2;
        if (stack.length === 0) rootClosed = true;
        break;
      }
      if (pos === before) return bad(); // attributes need whitespace before them
      if (readName() === null) return bad();
      skipSpace();
      if (s[pos] !== '=') return bad();
      pos += 1;
      skipSpace();
      const q = s[pos];
      if (q !== '"' && q !== "'") return bad();
      const close = s.indexOf(q, pos + 1);
      if (close === -1) { advance(s.length); return bad(); }
      if (s.slice(pos + 1, close).includes('<')) return bad();
      advance(close + 1);
    }
  }
  if (!rootSeen || !rootClosed || stack.length > 0) return { ok: false, line };
  return { ok: true };
}

export function validateB3PluginCode(name, code) {
  checkB3PluginText(code, 'B3_PLUGIN_CODE_INVALID');
  const className = b3PluginClassName(name);
  const text = typeof code === 'string' ? code : Buffer.from(code).toString('utf8');
  // Plain string matching instead of a RegExp built from the name (CodeQL js/regex-injection):
  // a line must start with "class <ClassName>" followed by a non-word character or line end.
  const head = `class ${className}`;
  const declared = text.split(/\r?\n/).some(line => line.startsWith(head) && !/\w/.test(line.charAt(head.length)));
  if (!declared) fail('B3_PLUGIN_CODE_INVALID');
}
