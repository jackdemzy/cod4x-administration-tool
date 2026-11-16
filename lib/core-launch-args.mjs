// Audit 4.18.31 (F-1, F-2): the CoD4x core joins its argv with spaces and splits the result at every
// "+" (Com_ParseCommandLine, no quote handling); each piece runs as a startup command. A "+" inside a
// value (a BaseGame path such as "/srv/b+loadPlugin evil", a server name, a free argument such as
// "+set fs_homepath /x") therefore becomes a command of its own. Every core start checks its final
// argument list here: a "+" may only open a bare command token, never appear inside a value.
const COMMAND = /^\+[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_IN_VALUE = /[+\0\r\n]/;

export function coreArgumentProblem(args) {
  if (!Array.isArray(args)) return 'not a list';
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (typeof value !== 'string') return `argument ${index + 1} is not text`;
    if (value.startsWith('+')) { if (!COMMAND.test(value)) return `argument ${index + 1} is not a plain command`; continue; }
    if (FORBIDDEN_IN_VALUE.test(value)) return `argument ${index + 1} contains "+" or a line break`;
  }
  return null;
}

export function assertCoreLaunchArgs(args, code = 'CORE_ARGUMENT_INVALID') {
  const problem = coreArgumentProblem(args);
  if (problem) throw Object.assign(new Error(`Server start refused: ${problem} (the core would read it as an extra command).`), { code });
  return args;
}

// For values that become core arguments later (paths, names): no "+" and no line break.
export const unsafeCoreValue = value => typeof value === 'string' && FORBIDDEN_IN_VALUE.test(value);
