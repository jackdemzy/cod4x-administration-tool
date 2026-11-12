import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditReport, gateProblems } from '../scripts/security-audit-report.mjs';

const NAMES = ['Local runtime', 'Secrets', 'B3', 'Remote Linux', 'Remote access and admin API', 'Electron and dependencies'];
const HEADER = '| ID | Title | Attacker | Grade | Status | Evidence |\n|----|-------|----------|-------|--------|----------|';

function report(rows, { reviewed = [1, 2, 3, 4, 5, 6], areas = [1, 2, 3, 4, 5, 6] } = {}) {
  const sections = areas.map(n => `## Area ${n} – ${NAMES[n - 1]}\n\nReviewed: ${reviewed.includes(n) ? 'yes' : 'no'}\n`).join('\n');
  return `# Security audit 4.18.26\n\n${sections}\n## Findings\n\n${HEADER}\n${rows.join('\n')}\n\n## Rejected findings\n`;
}
const row = (id, title, attacker, grade, status, evidence = '') => `| ${id} | ${title} | ${attacker} | ${grade} | ${status} | ${evidence} |`;
const exists = () => true;

test('parses areas and findings', () => {
  const parsed = parseAuditReport(report([
    row('A1-1', 'Path escape', 'A5', 'High', 'fixed', '`test/a.test.mjs`'),
    row('A2-1', 'Verbose error', 'A2', 'Low', 'issue #45'),
    row('A3-1', 'Plugin name', 'A5', 'Medium', 'rejected'),
  ]));
  assert.deepEqual(parsed.areas, [1, 2, 3, 4, 5, 6].map(number => ({ number, reviewed: true })));
  assert.equal(parsed.findings.length, 3);
  assert.deepEqual(parsed.findings[0], { id: 'A1-1', title: 'Path escape', attacker: 'A5', grade: 'High', status: 'fixed', evidence: ['test/a.test.mjs'] });
  assert.deepEqual(parsed.findings[1].status, { issue: 45 });
  assert.equal(parsed.findings[1].grade, 'Low');
  assert.equal(parsed.findings[2].status, 'rejected');
  assert.deepEqual(parsed.findings[2].evidence, []);
});

test('escaped pipe in title keeps the columns', () => {
  const [finding] = parseAuditReport(report([row('A4-2', 'uses \\| in `sh -c`', 'A6', 'Medium', 'fixed', '`test/b.test.mjs`, `test/c.test.mjs`')])).findings;
  assert.equal(finding.title, 'uses | in `sh -c`');
  assert.equal(finding.grade, 'Medium');
  assert.equal(finding.status, 'fixed');
  assert.deepEqual(finding.evidence, ['test/b.test.mjs', 'test/c.test.mjs']);
});

test('grade and status are case-insensitive', () => {
  const [finding] = parseAuditReport(report([row('A5-1', 'x', 'A1', 'high', 'Fixed', '`test/a.test.mjs`')])).findings;
  assert.equal(finding.grade, 'High');
  assert.equal(finding.status, 'fixed');
});

test('unknown grade or status throws AUDIT_REPORT_INVALID', () => {
  assert.throws(() => parseAuditReport(report([row('A5-1', 'x', 'A1', 'Severe', 'fixed')])), { code: 'AUDIT_REPORT_INVALID' });
  assert.throws(() => parseAuditReport(report([row('A5-1', 'x', 'A1', 'High', 'later')])), { code: 'AUDIT_REPORT_INVALID' });
  assert.throws(() => parseAuditReport(report([row('A9-1', 'x', 'A1', 'High', 'fixed')])), { code: 'AUDIT_REPORT_INVALID' });
});

test('gateProblems names each blocking problem', () => {
  const one = (rows, options, has = exists) => {
    const problems = gateProblems(parseAuditReport(report(rows, options)), { exists: has });
    assert.equal(problems.length, 1, problems.join('\n'));
    return problems[0];
  };
  assert.match(one([row('A1-1', 'x', 'A4', 'Medium', 'open')]), /A1-1/);
  assert.match(one([row('A5-2', 'x', 'A1', 'High', 'open')]), /A5-2/);
  assert.match(one([row('A2-3', 'x', 'A2', 'Low', 'open')]), /A2-3.*issue/);
  assert.match(one([row('A3-1', 'x', 'A5', 'High', 'fixed')]), /A3-1.*test/);
  assert.match(one([row('A3-2', 'x', 'A5', 'Critical', 'fixed', '`test/missing.test.mjs`')], undefined, path => path !== 'test/missing.test.mjs'), /A3-2.*test\/missing\.test\.mjs/);
  assert.match(one([], { reviewed: [1, 2, 3, 5, 6] }), /Area 4/);
  assert.match(one([], { areas: [1, 2, 3, 4, 5] }), /Area 6/);
});

test('a clean report has no problems', () => {
  const parsed = parseAuditReport(report([
    row('A1-1', 'x', 'A5', 'High', 'fixed', '`test/a.test.mjs`'),
    row('A2-1', 'x', 'A2', 'Low', 'issue #7'),
    row('A6-1', 'x', 'A3', 'Medium', 'rejected'),
  ]));
  assert.deepEqual(gateProblems(parsed, { exists }), []);
});
