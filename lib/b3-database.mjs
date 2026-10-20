// Pure B3 database logic for Block 14: input validation, DSN, schema
// classification against the audited eBc-B3 b3/sql/mysql/b3.sql, error
// mapping and migration planning. No I/O here.
//
// eBc-B3 b3/functions.py splitDSN parses mysql://user:password@host:port/db
// without URL decoding: the user stops at ':', the password at the first '@',
// the host at '/' or ':'. The rules below keep every value unambiguous.

const fail = code => { throw Object.assign(new Error(code), { code }); };

export const CORE_SQL = 'b3/sql/mysql/b3.sql';
export const EBC_SQL = 'b3/sql/mysql/b3-update-ebc.sql';
export const EBC_TABLES = Object.freeze(['player_core', 'prestige_log']);
export const EBC_CONFIRMATION = 'DROP player_core AND prestige_log';

const SETTING_KEYS = new Set(['host', 'port', 'database', 'username']);

export function validateDatabaseSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !SETTING_KEYS.has(key))) fail('B3_DATABASE_SETTINGS_INVALID');
  const { host, database, username, port = 3306 } = input;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) fail('B3_DATABASE_SETTINGS_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('B3_DATABASE_SETTINGS_INVALID');
  if (typeof database !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(database)) fail('B3_DATABASE_SETTINGS_INVALID');
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(username)) fail('B3_DATABASE_SETTINGS_INVALID');
  return { host, database, username, port };
}

export function validDatabasePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value) || /[@";\\]/.test(value)) fail('CREDENTIAL_INVALID');
}

// Only for b3.xml; never log or return the result.
export function buildMysqlDsn(settings, password) {
  const { host, port, database, username } = validateDatabaseSettings(settings);
  validDatabasePassword(password);
  return `mysql://${username}:${password}@${host}:${port}/${database}`;
}

// Splits a SQL script into statements outside quotes and comments.
// Versioned comments (/*!40101 ... */) are MySQL code and are kept.
export function splitSqlStatements(text) {
  const statements = [];
  let current = '', i = 0;
  const source = String(text);
  while (i < source.length) {
    const char = source[i], next = source[i + 1];
    if ((char === '-' && next === '-' && /[\s]/.test(source[i + 2] ?? '\n')) || char === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      if (source[i + 2] === '!') current += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\' && char !== '`') { j += 2; continue; }
        if (source[j] === char) { if (source[j + 1] === char) { j += 2; continue; } break; }
        j++;
      }
      current += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += char;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function statementTable(sql) {
  return /^(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|INSERT\s+(?:IGNORE\s+)?INTO)\s+`?(\w+)`?/i.exec(String(sql))?.[1] ?? null;
}

export function parseSchemaFile(text) {
  const tables = {};
  for (const statement of splitSqlStatements(text)) {
    if (!/^CREATE\s+TABLE/i.test(statement)) continue;
    const name = statementTable(statement);
    const body = statement.slice(statement.indexOf('(') + 1);
    tables[name] = [...body.matchAll(/^\s*`(\w+)`\s/gm)].map(match => match[1]);
  }
  return { tables };
}

export function classifySchema(expected, actual) {
  const present = actual || {};
  const missingTables = Object.keys(expected).filter(name => !present[name]);
  const missingColumns = {};
  for (const [name, columns] of Object.entries(expected)) {
    if (!present[name]) continue;
    const missing = columns.filter(column => !present[name].includes(column));
    if (missing.length) missingColumns[name] = missing;
  }
  const state = missingTables.length === Object.keys(expected).length ? 'EMPTY'
    : Object.keys(missingColumns).length ? 'OUTDATED'
    : missingTables.length ? 'PARTIAL' : 'COMPLETE';
  return { state, missingTables, missingColumns };
}

const UNREACHABLE = new Set([2002, 2003, 2005, 2006, 2013, 'TIMEOUT']);
export function classifyDatabaseError(code) {
  if (UNREACHABLE.has(code)) return 'DB_UNREACHABLE';
  if (code === 1045 || code === 1698) return 'DB_AUTH_FAILED';
  if (code === 1044) return 'DB_ACCESS_DENIED';
  if (code === 1049) return 'DB_NOT_FOUND';
  if (code === 'DRIVER_MISSING') return 'DB_DRIVER_MISSING';
  if (code === 'BACKUP_DRIVER_UNSUPPORTED') return 'DB_BACKUP_DRIVER_UNSUPPORTED';
  // Block 15 admin queries.
  if (code === 'CLIENT_NOT_FOUND') return 'B3_ADMIN_CLIENT_NOT_FOUND';
  if (code === 'GROUP_NOT_FOUND') return 'B3_ADMIN_GROUP_NOT_FOUND';
  if (code === 'PENALTY_NOT_FOUND') return 'B3_ADMIN_PENALTY_NOT_FOUND';
  if (code === 'QUERY_INVALID') return 'B3_ADMIN_INPUT_INVALID';
  return 'DB_ERROR';
}

// A backup is required whenever the database holds any table at all.
export function planMigration({ schema, tableCount, ebcOptIn = false, confirmation }) {
  if (schema?.state === 'OUTDATED') fail('SCHEMA_OUTDATED');
  if (ebcOptIn && confirmation !== EBC_CONFIRMATION) fail('EBC_CONFIRMATION_REQUIRED');
  const files = [];
  if (['EMPTY', 'PARTIAL'].includes(schema?.state)) files.push(CORE_SQL);
  if (ebcOptIn) files.push(EBC_SQL);
  if (!files.length) fail('B3_DATABASE_NOTHING_TO_DO');
  return { files, backup: tableCount > 0 };
}
