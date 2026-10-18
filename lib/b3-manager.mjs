// Roadmap Block 13: B3 manager dashboard. Pure evaluation of evidence that
// other modules collect (dependency check, B3 runtime, B3 log, generated
// config, CoD4x server state). Log markers are the exact eBc-B3 9096624 messages:
//   b3/storage/sqlite.py  "Using database file:", "Database connection failed"
//   b3/storage/mysql.py   "Successfully established a connection with MySQL database",
//                         "Database connection failed", "Missing MySQL database tables"
//   b3/parser.py          "Starting <Parser> v<version> for server", "Start reading game events",
//                         "Cannot setup RCON"
//   b3/parsers/q3a/rcon.py "RCON: received" (verbose2), "RCON: too many tries: aborting",
//                         "RCON: error reading"

// The level only counts when followed by whitespace, so undated lines such as
// "Start reading game events" keep their first character.
const LINE = /^(?<date>\d{6} \d{2}:\d{2}:\d{2})?\s*(?:(?<level>[A-Z][A-Z0-9]*)\s+)?(?<text>.*)$/;
const RUN_START = /Starting (\w+Parser) v([\w.]+) for server/;
const empty = () => ({ parser: { name: null, version: null, started: false, reading: false }, database: { kind: null, state: 'UNKNOWN' }, rcon: { state: 'UNKNOWN' }, publist: 'UNKNOWN', critical: null });

// Last relevant line wins for each area; returns fixed states only. B3 appends
// to b3.log across runs (b3/output.py RotatingFileHandler), so every new parser
// start resets all evidence: nothing from a previous run may describe this one.
export function parseB3Log(text) {
  let result = empty();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = LINE.exec(raw)?.groups?.text ?? raw;
    const parser = RUN_START.exec(line);
    if (parser) { result = empty(); Object.assign(result.parser, { name: parser[1], version: parser[2], started: true, reading: false }); }
    if (line.includes('Start reading game events')) result.parser.reading = true;
    if (line.includes('Using database file:')) result.database = { kind: 'sqlite', state: 'CONNECTED' };
    if (line.includes('Successfully established a connection with MySQL database')) result.database = { kind: 'mysql', state: 'CONNECTED' };
    if (line.includes('Connecting to MySQL database')) result.database = { kind: 'mysql', state: 'CONNECTING' };
    if (line.includes('Database connection failed')) result.database = { kind: result.database.kind, state: 'OFFLINE' };
    if (line.includes('Missing MySQL database tables')) result.database = { kind: 'mysql', state: 'SCHEMA_MISSING' };
    // Native finding (Block 13): with log_level 9 B3 logs no "RCON: received"
    // (verbose2); answers appear as DEBUG "Get cvar <name> = [<answer>]".
    // A rejected password is not a connection (CoD4x sv_main.c: "Bad rcon",
    // "No rconpassword set on server ...").
    const answer = /Get cvar \w+ = \[(.*)/.exec(line)?.[1] ?? (line.includes('RCON: received') ? line : null);
    if (answer !== null) result.rcon = /Bad rcon|No rconpassword set/.test(answer) ? { state: 'AUTH_FAILED' } : { state: 'CONNECTED' };
    // publist is a B3 must-have plugin; it only stays silent for public_ip 127.0.0.1.
    if (line.includes('publist will not send heartbeat')) result.publist = 'SUPPRESSED';
    else if (/PublistPlugin: .*(sending heartbeat|Sending heartbeat)/i.test(line)) result.publist = 'SENDING';
    if (/RCON: too many tries: aborting|RCON: error reading/.test(line)) result.rcon = { state: 'OFFLINE' };
    if (line.includes('Cannot setup RCON')) { result.rcon = { state: 'OFFLINE' }; result.critical = 'RCON_SETUP_FAILED'; }
    if (/^CRITICAL\b/.test(LINE.exec(raw)?.groups?.level || '') && !result.critical) result.critical = 'B3_CRITICAL';
    // A critical error after startup ends event reading (b3/parser.py critical -> shutdown).
    if (result.critical) result.parser.reading = false;
  }
  return result;
}

// Settings CONTROL generated for this instance (no secrets are read or returned).
export function parseB3ConfigSummary(xml) {
  const value = name => new RegExp(`<set name="${name}">([^<]*)</set>`).exec(String(xml || ''))?.[1] ?? null;
  const database = value('database') || '';
  return { parser: value('parser'), databaseKind: /^(\w+):\/\//.exec(database)?.[1] || null, port: value('port') ? Number(value('port')) : null, publicIp: value('public_ip') };
}

// Redacts credential values before a config is shown in the UI or logs.
export function redactB3Config(xml) {
  return String(xml || '')
    .replace(/(<set name="(?:rcon_password|password|token|secret)[^"]*">)[^<]*(<\/set>)/gi, '$1[redacted]$2')
    // Greedy up to the last "@" of the value, so an "@" inside the password never leaks a rest.
    .replace(/(:\/\/[^:/@<\s]+:)[^<\s]*@/g, '$1[redacted]@');
}

export const B3_DIAGNOSES = Object.freeze(['PYTHON_MISSING', 'PYTHON_INCOMPATIBLE', 'B3_MISSING', 'B3_INCOMPATIBLE', 'DEPENDENCY_MISSING', 'COD4X_OFFLINE', 'DB_OFFLINE', 'PARSER_OFFLINE', 'RCON_OFFLINE']);
const check = (ok, state, code = null) => ({ ok, state, code });

// dependencies: B3Environment.check() result; runtime: B3Runtime snapshot;
// health: B3Runtime.health(); log: parseB3Log(); config: parseB3ConfigSummary();
// server: { status, reachable } of the CoD4x instance.
export function buildB3Dashboard({ dependencies, runtime, health, log, config, server }) {
  const row = id => dependencies?.results?.find(item => item.id === id) || null;
  const running = Boolean(runtime?.running) && health?.alive === true;
  const diagnosis = [];
  const python = row('python');
  const pythonCheck = python?.status === 'OK' ? check(true, python.found) : python?.status === 'INCOMPATIBLE' ? check(false, python.found, 'PYTHON_INCOMPATIBLE') : check(false, 'MISSING', 'PYTHON_MISSING');
  const source = row('b3-source');
  const sourceOk = source?.status === 'OK';
  const b3Check = !source || source.status === 'MISSING' ? check(false, 'MISSING', 'B3_MISSING')
    : !sourceOk ? check(false, source.status, 'B3_INCOMPATIBLE')
    : running ? check(true, runtime.status) : check(null, runtime?.status || 'STOPPED');
  const missingDependency = ['dateutil', 'mysql-driver'].some(id => row(id)?.status === 'MISSING');
  // Unknown is not offline: a failed process inspection (e.g. the Windows CIM
  // timeout) must not be reported as "CoD4X offline".
  const serverKnown = Boolean(server) && server.status !== 'UNKNOWN' && !(server.status === 'RUNNING' && server.reachable == null);
  const cod4xCheck = !serverKnown ? check(null, 'UNKNOWN')
    : server.status === 'RUNNING' && server.reachable === true ? check(true, 'RUNNING')
    : check(false, server.status === 'RUNNING' ? 'UNREACHABLE' : server.status, 'COD4X_OFFLINE');
  // Runtime evidence only counts while this B3 run is alive.
  const databaseKind = log?.database?.kind || config?.databaseKind || null;
  const databaseState = running ? log?.database?.state || 'UNKNOWN' : 'NOT_RUNNING';
  const databaseCheck = !running ? check(null, 'NOT_RUNNING') : databaseState === 'CONNECTED' ? check(true, `${databaseKind}:CONNECTED`) : ['OFFLINE', 'SCHEMA_MISSING'].includes(databaseState) ? check(false, databaseState, 'DB_OFFLINE') : check(null, databaseState);
  // MySQL is the roadmap target; SQLite is the Block 12 lifecycle store until Block 14.
  const mysqlCheck = databaseKind === 'mysql' ? databaseCheck : check(null, databaseKind ? `${databaseKind.toUpperCase()} (MySQL: Block 14)` : 'NOT_CONFIGURED');
  const parserCheck = !running ? check(null, 'NOT_RUNNING') : log?.parser?.reading ? check(true, `${log.parser.name} v${log.parser.version}`) : log?.critical ? check(false, log.critical, 'PARSER_OFFLINE') : check(null, log?.parser?.started ? 'STARTING' : 'UNKNOWN');
  const rconState = running ? log?.rcon?.state || 'UNKNOWN' : 'NOT_RUNNING';
  const rconCheck = !running ? check(null, 'NOT_RUNNING') : rconState === 'CONNECTED' ? check(true, 'CONNECTED') : ['OFFLINE', 'AUTH_FAILED'].includes(rconState) ? check(false, rconState, 'RCON_OFFLINE') : check(null, rconState);
  if (pythonCheck.code) diagnosis.push(pythonCheck.code);
  if (b3Check.code) diagnosis.push(b3Check.code);
  if (missingDependency) diagnosis.push('DEPENDENCY_MISSING');
  if (cod4xCheck.code) diagnosis.push('COD4X_OFFLINE');
  if (databaseCheck.code) diagnosis.push('DB_OFFLINE');
  if (parserCheck.code) diagnosis.push('PARSER_OFFLINE');
  if (rconCheck.code) diagnosis.push('RCON_OFFLINE');
  // Root cause first: a stopped server explains a failing RCON connection.
  const ordered = B3_DIAGNOSES.filter(code => diagnosis.includes(code));
  return {
    status: runtime?.status || 'STOPPED', health: health?.status || 'DOWN',
    version: { label: 'eBc/B3', b3: dependencies?.source?.b3Version || null, commit: dependencies?.source?.commit?.slice(0, 7) || null },
    parser: log?.parser?.name ? `${log.parser.name} v${log.parser.version}` : config?.parser || null,
    database: databaseState === 'NOT_RUNNING' ? 'NOT_RUNNING' : `${databaseKind || 'unknown'}:${databaseState}`,
    rcon: rconState,
    checks: { python: pythonCheck, b3: b3Check, mysql: mysqlCheck, database: databaseCheck, parser: parserCheck, rcon: rconCheck, cod4x: cod4xCheck },
    diagnosis: ordered, primary: ordered[0] || null,
    rconCause: rconCheck.code && cod4xCheck.code ? 'COD4X_OFFLINE' : null,
    // B3's publist plugin would report the server to bigbrotherbot.net unless public_ip is 127.0.0.1.
    publist: !config ? 'UNKNOWN' : config.publicIp === '127.0.0.1' ? 'SUPPRESSED' : 'EXPOSED',
  };
}
