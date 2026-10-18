// Secret CVARs that may reach the Dedicated Core as `+set <name> <value>`.
// Their values must never enter runtime history, persisted state or output.
const SECRET_CVARS = Object.freeze(['rcon_password', 'g_password', 'sv_privatepassword', 'sv_authtoken']);
const SECRET_SET = new Set(SECRET_CVARS);
const REDACTED = '[redacted]';
const SECRET_PATTERN = SECRET_CVARS.join('|');

export function isSecretCvar(name) { return SECRET_SET.has(String(name || '').toLowerCase()); }

export function redactRuntimeArguments(args) {
  if (!Array.isArray(args)) return [];
  const result = args.map(String);
  for (let index = 0; index < result.length - 2; index++) {
    if (['+set', '+seta', 'set', 'seta'].includes(result[index].toLowerCase()) && isSecretCvar(result[index + 1])) result[index + 2] = REDACTED;
  }
  return result;
}

// Swallows the rest of the line after a secret name. Applied to the complete
// accumulated text, a line continued in a later chunk is redacted again.
export function redactRuntimeOutput(text) {
  return String(text ?? '').replace(new RegExp(`\\b(${SECRET_PATTERN})\\b[^\\n]*`, 'gi'), `$1 ${REDACTED}`);
}

export function redactProcessInfo(info) {
  if (!info || typeof info !== 'object') return info;
  const result = { ...info };
  if (typeof result.commandLine === 'string') result.commandLine = redactRuntimeOutput(result.commandLine);
  if (Array.isArray(result.argv)) result.argv = redactRuntimeArguments(result.argv);
  return result;
}
