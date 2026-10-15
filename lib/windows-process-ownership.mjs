import path from 'node:path';

// Parse quoted Windows arguments without evaluating a shell.
export function parseWindowsArguments(commandLine) {
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++;
    if (index >= commandLine.length) break;
    let value = '', quoted = false;
    while (index < commandLine.length && (quoted || !/\s/.test(commandLine[index]))) {
      let slashes = 0;
      while (commandLine[index] === '\\') { slashes++; index++; }
      if (commandLine[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"'; else quoted = !quoted;
        index++;
      } else {
        value += '\\'.repeat(slashes);
        if (index < commandLine.length) value += commandLine[index++];
      }
    }
    if (quoted) return null;
    args.push(value);
  }
  return args;
}

export function assertWindowsInstanceOwnership(info, { homePath, port, createdAt }) {
  const fail = () => { throw Object.assign(new Error('Serverinstanz konnte anhand Homepath, Port und Prozess-Erstellzeit nicht eindeutig zugeordnet werden.'), { code: 'INSTANCE_PROCESS_IDENTITY_BLOCKED' }); };
  if (!info.commandLine || !info.createdAt) fail();
  const args = parseWindowsArguments(info.commandLine);
  if (!args) fail();
  const values = new Map();
  for (let i = 1; i < args.length; i++) if (args[i].toLowerCase() === '+set') {
    const key = String(args[i + 1] || '').toLowerCase();
    if (['fs_homepath', 'net_port'].includes(key)) {
      if (values.has(key) || !args[i + 2]) fail();
      values.set(key, args[i + 2]);
    }
    i += 2;
  }
  if (!values.get('fs_homepath') || path.win32.resolve(values.get('fs_homepath')).toLowerCase() !== path.win32.resolve(homePath).toLowerCase() || values.get('net_port') !== String(port)) fail();
  if (createdAt && createdAt !== info.createdAt) fail();
}
