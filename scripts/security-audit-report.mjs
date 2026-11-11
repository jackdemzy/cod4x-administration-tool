// Reads docs/SECURITY-AUDIT-<version>.md (Roadmap Block 20) so the security gate can tell
// whether every area was reviewed and no Critical, High or Medium finding is still open.

const GRADES = ['Critical', 'High', 'Medium', 'Low'];
const BLOCKING = new Set(['Critical', 'High', 'Medium']);
const AREAS = [1, 2, 3, 4, 5, 6];
const HEADER = ['id', 'title', 'attacker', 'grade', 'status', 'evidence'];

function invalid(message) {
  const error = new Error(message);
  error.code = 'AUDIT_REPORT_INVALID';
  return error;
}

function cells(line) {
  const parts = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') { current += '|'; i += 1; continue; }
    if (line[i] === '|') { parts.push(current.trim()); current = ''; continue; }
    current += line[i];
  }
  parts.push(current.trim());
  return parts.slice(1, -1);
}

function grade(value, id) {
  const found = GRADES.find(name => name.toLowerCase() === value.toLowerCase());
  if (!found) throw invalid(`${id}: unknown grade "${value}"`);
  return found;
}

function status(value, id) {
  const lower = value.toLowerCase();
  if (lower === 'fixed' || lower === 'rejected' || lower === 'open') return lower;
  const issue = /^issue #(\d+)$/.exec(lower);
  if (issue) return { issue: Number(issue[1]) };
  throw invalid(`${id}: unknown status "${value}"`);
}

export function parseAuditReport(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const areas = [];
  const findings = [];
  let area = null;
  let inTable = false;
  for (const line of lines) {
    const heading = /^## Area (\d+)\b/.exec(line);
    if (heading) {
      area = { number: Number(heading[1]), reviewed: false };
      areas.push(area);
      continue;
    }
    if (line.startsWith('## ')) area = null;
    const reviewed = /^Reviewed:\s*(yes|no)\s*$/i.exec(line);
    if (reviewed && area) { area.reviewed = reviewed[1].toLowerCase() === 'yes'; continue; }
    if (!line.trim().startsWith('|')) { inTable = false; continue; }
    const row = cells(line.trim());
    if (row.map(cell => cell.toLowerCase()).join() === HEADER.join()) { inTable = true; continue; }
    if (!inTable || row.every(cell => /^:?-+:?$/.test(cell))) continue;
    if (row.length !== HEADER.length) throw invalid(`finding row has ${row.length} columns: ${line}`);
    const [id, title, attacker, gradeCell, statusCell, evidenceCell] = row;
    if (!/^A[1-6]-\d+$|^B-\d+$/.test(id)) throw invalid(`unknown finding id "${id}"`);
    findings.push({
      id, title, attacker,
      grade: grade(gradeCell, id),
      status: status(statusCell, id),
      evidence: [...evidenceCell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean),
    });
  }
  return { areas, findings };
}

export function gateProblems(report, { exists }) {
  const problems = [];
  for (const number of AREAS) {
    const area = report.areas.find(entry => entry.number === number);
    if (!area) problems.push(`Area ${number} is missing from the report`);
    else if (!area.reviewed) problems.push(`Area ${number} is not reviewed`);
  }
  for (const finding of report.findings) {
    const { id, grade: level, status: state, evidence } = finding;
    if (state === 'rejected') continue;
    if (state === 'fixed') {
      if (!evidence.length) problems.push(`${id} is fixed but names no regression test`);
      for (const file of evidence) if (!exists(file)) problems.push(`${id} names a regression test that does not exist: ${file}`);
      continue;
    }
    if (BLOCKING.has(level)) problems.push(`${id} (${level}) is still open`);
    else if (state === 'open') problems.push(`${id} (Low) needs a GitHub issue`);
  }
  return problems;
}
