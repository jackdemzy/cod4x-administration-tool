# Security audit 4.18.26 (Roadmap Block 20)

Design, threat model (attackers A1 to A7) and severity scale: [`docs/superpowers/specs/2026-11-11-security-audit-design.md`](superpowers/specs/2026-11-11-security-audit-design.md). Plan: [`docs/superpowers/plans/2026-11-11-security-audit.md`](superpowers/plans/2026-11-11-security-audit.md).

Each area was read by its own independent reviewer. Every finding was then confirmed by a test that reproduced it, or rejected with a reason. Critical, High and Medium findings are fixed; Low findings are tracked as GitHub issues. `scripts/verify-4.18.26-security-gate.mjs` reads this file: it fails while an area is not reviewed or a Critical, High or Medium finding is open, and it re-runs every regression test named below.

## Area 1 – Local runtime

Reviewed: no

## Area 2 – Secrets

Reviewed: no

## Area 3 – B3

Reviewed: no

## Area 4 – Remote Linux

Reviewed: no

## Area 5 – Remote access and admin API

Reviewed: no

## Area 6 – Electron and dependencies

Reviewed: no

## Findings

| ID | Title | Attacker | Grade | Status | Evidence |
|----|-------|----------|-------|--------|----------|

## Rejected findings

## Native checks
