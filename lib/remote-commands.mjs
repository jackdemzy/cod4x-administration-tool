import { shellQuote, assertRemotePosixPath, validRemoteInstanceId } from './remote-safety.mjs';

// Block 18: the ONLY commands CONTROL runs on a server. Each builder returns one
// command string made of fixed words and shellQuote()d values. Paths pass
// assertRemotePosixPath, numbers are checked integers, names match a fixed pattern.
// Nothing else in the code base builds a remote command.
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const MAX_PID = 4_194_304; // Linux pid_max upper bound
const MAX_ARGUMENTS = 256;
const NAME = /^[a-z][a-z0-9]{0,31}$/;

const argument = value => {
  if (typeof value !== 'string') fail('REMOTE_ARGUMENT_INVALID');
  return shellQuote(value);
};
const port = value => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail('REMOTE_ARGUMENT_INVALID');
  return String(value);
};

// ---- platform probe -------------------------------------------------------
export const probeCommand = () => 'printf \'%s %s\\n%s\\n%s\\n\' "$(uname -s)" "$(uname -m)" "$(id -u)" "$(id -g)"';

export function parseProbe(stdout) {
  const lines = Buffer.from(stdout).toString('utf8').split('\n');
  const platform = /^(\S+) (\S+)$/.exec(lines[0] || '');
  if (lines.length !== 4 || lines[3] !== '' || !platform || !/^\d{1,10}$/.test(lines[1]) || !/^\d{1,10}$/.test(lines[2])) fail('REMOTE_PROBE_INVALID');
  const probe = { os: platform[1], arch: platform[2], uid: Number(lines[1]), gid: Number(lines[2]) };
  if (probe.os !== 'Linux' || probe.arch !== 'x86_64') fail('REMOTE_PLATFORM_UNSUPPORTED');
  return probe;
}

// ---- directories ----------------------------------------------------------
// The home itself is created without -p, so an existing home is never adopted.
export function makeDirectoriesCommand(home, names) {
  const root = assertRemotePosixPath(home);
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !NAME.test(name))) fail('REMOTE_ARGUMENT_INVALID');
  const create = `mkdir -m 0700 -- ${shellQuote(root)}`;
  return names.length ? `${create} && mkdir -m 0700 -- ${names.map(name => shellQuote(`${root}/${name}`)).join(' ')}` : create;
}

// ---- start ----------------------------------------------------------------
// Runs the core in its own session, stdin from /dev/null, stdout and stderr in two
// NEW files (noclobber: an existing file stops the start). The files are created in a
// subshell with umask 077, so they are private while the core keeps the normal umask.
// A small wrapper shell does the redirections, prints its own pid on the original stdout
// and then execs the core, so the printed pid IS the core's pid (not a wrapper's).
// Nothing is printed when a file cannot be created or the core is not an executable file.
const START_SCRIPT = [
  'set -C',
  'cwd=$1; out=$2; err=$3; shift 3',
  '[ -f "$1" ] && [ -x "$1" ] || exit 127',
  'cd -- "$cwd" || exit 126',
  '( umask 077; : > "$out" && : > "$err" ) || exit 125',
  'exec 3>&1 < /dev/null >> "$out" 2>> "$err"',
  'echo $$ >&3',
  'exec 3>&-',
  'exec "$@"',
].join('; ');

export function startCoreCommand({ core, cwd, args, stdoutFile, stderrFile }) {
  const paths = [cwd, stdoutFile, stderrFile, core].map(value => assertRemotePosixPath(value));
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) fail('REMOTE_ARGUMENT_INVALID');
  const [cwdPath, out, err, corePath] = paths;
  return `setsid sh -c ${shellQuote(START_SCRIPT)} sh ${[cwdPath, out, err, corePath].map(shellQuote).join(' ')} ${args.map(argument).join(' ')} &`.replace(/ +&$/, ' &');
}

export function parsePid(stdout) {
  const match = /^(\d{1,10})\n$/.exec(Buffer.from(stdout).toString('utf8'));
  const pid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > MAX_PID) fail('REMOTE_START_FAILED');
  return pid;
}

// ---- signals --------------------------------------------------------------
export function signalCommand(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > MAX_PID || !['TERM', 'KILL'].includes(signal)) fail('REMOTE_ARGUMENT_INVALID');
  return `kill -s ${signal} ${pid}`;
}

// ---- getinfo / getstatus probes ---------------------------------------------
// One UDP query to the server itself. bash /dev/udp when there is a bash, else python3,
// else exit 3 (no tool). Prints the raw answer (it starts with four 0xFF bytes) or nothing.
// These queries carry no secret.
function probeFor(query) {
  const python = 'import socket,sys;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1);'
    + `s.sendto(b"\\xff\\xff\\xff\\xff${query}\\n",("127.0.0.1",int(sys.argv[1])));sys.stdout.buffer.write(s.recvfrom(65535)[0])`;
  const bash = `exec 3<>/dev/udp/127.0.0.1/"$0" && printf "\\377\\377\\377\\377${query}\\n" >&3 && timeout 1 cat <&3`;
  return serverPort => {
    const value = port(serverPort);
    return `if command -v bash >/dev/null 2>&1; then bash -c ${shellQuote(bash)} ${value}; `
      + `elif command -v python3 >/dev/null 2>&1; then python3 -c ${shellQuote(python)} ${value}; else exit 3; fi`;
  };
}
export const getinfoProbeCommand = probeFor('getinfo control');
// Block 18b: monitoring, like the local getstatus probe (no RCON password).
export const getstatusProbeCommand = probeFor('getstatus monitor');

// ---- RCON exchange (Block 18b) ----------------------------------------------
// The packet carries the RCON password, so it arrives on stdin and never in this command line.
// python3 only: there is no bash fallback for a secret. The script sends exactly one datagram
// (1..1400 bytes) to 127.0.0.1:<port> and collects the replies until 150 ms of silence, 1.5 s
// in total or 65536 bytes, each written as a 4-byte big-endian length and the datagram.
// Exit 0 = replies printed, 3 = no python3, 4 = no reply, 5 = bad packet on stdin.
const RCON_EXCHANGE = [
  'import socket,sys,select,time,struct',
  'data=sys.stdin.buffer.read(1401)',
  'if not data or len(data)>1400: sys.exit(5)',
  's=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)',
  's.connect(("127.0.0.1",int(sys.argv[1])))',
  's.send(data)',
  'data=None',
  'out=sys.stdout.buffer',
  'total=0',
  'got=False',
  'end=time.monotonic()+1.5',
  'while True:',
  '  left=end-time.monotonic()',
  '  if left<=0: break',
  '  ready=select.select([s],[],[],min(0.15,left) if got else left)[0]',
  '  if not ready:',
  '    if got: break',
  '    continue',
  '  try: part=s.recv(65535)',
  '  except OSError: break',
  '  if total+len(part)>65536: break',
  '  out.write(struct.pack(">I",len(part))+part)',
  '  total+=len(part)',
  '  got=True',
  'out.flush()',
  'sys.exit(0 if got else 4)',
].join('\n');

export function rconExchangeCommand(serverPort) {
  const value = port(serverPort);
  return `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${shellQuote(RCON_EXCHANGE)} ${value}; else exit 3; fi`;
}

export function parseRconFrames(stdout) {
  const bytes = Buffer.from(stdout);
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) fail('REMOTE_RCON_REPLY_INVALID');
    const length = bytes.readUInt32BE(offset);
    if (offset + 4 + length > bytes.length) fail('REMOTE_RCON_REPLY_INVALID');
    frames.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return frames;
}

// The private files that carried the RCON password at start (Block 18b). Only main/ of the
// given home, only regular files named rcon-*.cfg. A home without main/ has nothing to sweep.
export function removeRconFilesCommand(home) {
  const main = `${assertRemotePosixPath(home)}/main`;
  return `[ -d ${shellQuote(main)} ] || exit 0; find ${shellQuote(main)} -maxdepth 1 -type f -name 'rcon-*.cfg' -delete`;
}

// ---- free space -----------------------------------------------------------
export const diskFreeCommand = path => `df -Pk -- ${shellQuote(assertRemotePosixPath(path))} | tail -n 1`;

export function parseDiskFree(stdout) {
  const match = /^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+\S.*\n?$/.exec(Buffer.from(stdout).toString('utf8'));
  if (!match) fail('REMOTE_DISKFREE_INVALID');
  return Number(match[1]);
}

// ---- file metadata --------------------------------------------------------
// SFTP attributes carry no link count, device or inode, which the output-file checks
// need. LC_ALL=C keeps error messages in English so they can be told apart.
// Prints: <mode hex> <uid> <gid> <size> <links> <device> <inode>
export function statCommand(path, { follow = false } = {}) {
  return `LC_ALL=C stat ${follow ? '-L ' : ''}-c '%f %u %g %s %h %d %i' -- ${shellQuote(assertRemotePosixPath(path))}`;
}

export function parseStat(stdout) {
  const match = /^([0-9a-f]{1,8}) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)\n$/.exec(Buffer.from(stdout).toString('utf8'));
  if (!match) fail('REMOTE_STAT_INVALID');
  const [mode, uid, gid, size, nlink, dev, ino] = [parseInt(match[1], 16), ...match.slice(2).map(Number)];
  return { mode, uid, gid, size, nlink, dev, ino };
}

// ---- recovery -------------------------------------------------------------
// A half-installed home is moved to <root>/.recovery/<id>-<token> (never deleted, never over an
// existing target). The home must lie directly below the root.
export function recoverHomeCommand(remoteRoot, home, token) {
  const root = assertRemotePosixPath(remoteRoot);
  const source = assertRemotePosixPath(home, { under: root });
  const id = source.slice(root.length + 1);
  if (!validRemoteInstanceId(id) || typeof token !== 'string' || !/^[a-z0-9-]{8,64}$/.test(token)) fail('REMOTE_ARGUMENT_INVALID');
  const recovery = `${root}/.recovery`;
  const target = shellQuote(`${recovery}/${id}-${token}`);
  // [ ] instead of mv -n: mv -n succeeds without moving, and into an existing directory it moves the source inside it
  return `mkdir -p -m 0700 -- ${shellQuote(recovery)} && [ ! -e ${target} ] && [ ! -L ${target} ] && mv -- ${shellQuote(source)} ${target}`;
}
