# Invariants Runbook

This system treats inventory correctness as a first-class safety constraint. Invariants are checks that must hold across ledger, warehouse hierarchy, and reservations. When invariants fail, the system **fails fast** or blocks unsafe actions instead of silently repairing data.

## Invariant Contract

- Ledger is append-only: `inventory_movements` and `inventory_movement_lines` are immutable after insert. `UPDATE` / `DELETE` / `TRUNCATE` on ledger tables are blocked by trigger/function guardrails.
- Trigger drift is CI-guarded: behavior, trigger metadata, and role posture tests must stay green:
  - `tests/architecture/ledger-immutability-guard.test.mjs`
  - `tests/architecture/ledger-immutability-trigger-metadata.test.mjs`
  - `tests/architecture/ledger-immutability-role-guard.test.mjs`
- Migration lint is strict and auditable:
  - dangerous statements require pragma + immediate reason + ticket token (`INV-123` or `#123`)
  - pragma with no dangerous statement is rejected
  - pragma cannot suppress dangerous statements in `up()`; only `down()`-section use is allowed
- CI DB principal posture must be least-privilege:
  - not superuser
  - not owner of ledger tables
  - not member of managed super roles such as `rds_superuser`
- Transactional DB idempotency is part of correctness:
  - endpoint identifiers come from `src/lib/idempotencyEndpoints.ts` and must be unique
  - payload hash mismatch and cross-endpoint key reuse fail loud (`409`)
  - replay returns stored response only when endpoint+payload match
  - retention pruning is batched and validated by `tests/ops/idempotency-retention-safety.test.mjs`
- To intentionally evolve immutability safely:
  1. create a migration with explicit pragma + reason + ticket (if and only if dangerous statement is required)
  2. update immutability trigger/function metadata guards
  3. update idempotency/invariant guard tests and docs in the same PR
  4. run `npm run test:ledger-immutability` and `npm run test:financial-core` before merge

## Severity Levels

- **CRITICAL**: Must be corrected before any further hierarchy changes. These raise blocks and can prevent reparents.
- **WARNING**: Logged for visibility; no blocking and no automatic changes.

## Invariants in Production

### WAREHOUSE_ID_DRIFT (CRITICAL)
**What it means:**
`locations.warehouse_id` does not match the resolved warehouse derived from the location’s ancestry.

**Why it matters:**
ATP, defaults, and reservations are warehouse-scoped. Drift creates silent cross-warehouse contamination.

**Behavior:**
- Logged as a critical invariant finding.
- A per-tenant block is recorded in `inventory_invariant_blocks`.
- Any attempt to change `parent_location_id` fails with `WAREHOUSE_ID_DRIFT_REPARENT_BLOCKED` until drift is fixed.

**No auto-repair:**
This invariant does **not** update `locations` or attempt any automatic correction.

### RESERVATION_WAREHOUSE_HISTORICAL_MISMATCH (WARNING)
**What it means:**
`inventory_reservations.warehouse_id` (historical intent) does not match the current `locations.warehouse_id` for the reservation’s location.

**Why it matters:**
`inventory_reservations.warehouse_id` is immutable audit intent. The mismatch indicates historical drift, not a system error.

**Behavior:**
- Logged as a warning.
- **No block** is created.
- **No updates** are made to reservation rows.

## How to Run the Invariants Job

From code (used in db tests):

```js
const { runInventoryInvariantCheck } = require('../../src/jobs/inventoryInvariants.job.ts');
const results = await runInventoryInvariantCheck({ tenantIds: [tenantId] });
```

In API/admin usage (if exposed):

```bash
POST /admin/inventory-invariants
```

## Operational Guidance

- Treat CRITICAL findings as blockers. Resolve drift before reparenting or warehouse changes.
- Warnings are informational. Track and audit; do not mutate historical data.

## Related Docs

- Warehouses: `docs/engineering/runbooks/warehouses.md`
- CI/testing workflow: `docs/engineering/runbooks/ci.md`
- Debugging tests: `docs/engineering/runbooks/debugging_tests.md`

## Ledger Immutability Migration Guard

Architecture guard `tests/architecture/ledger-migration-lint.test.mjs` fails if any migration contains dangerous ledger immutability statements (for example trigger disable/drop, truncate, or dropping `prevent_ledger_mutation`).

If a dangerous migration is intentionally required, add an explicit auditable override inside that migration file:

```sql
-- ledger-immutability:allow-dangerous-migration
-- reason: <why this dangerous migration is required> <ticket e.g. INV-123 or #123>
```

The reason line is mandatory immediately after the pragma and must include a ticket/reference token (`INV-123` or `#123`).

When intentionally changing ledger immutability triggers:

- include the pragma + reason + ticket in the migration file
- update both ledger tests:
  - `tests/architecture/ledger-immutability-guard.test.mjs`
  - `tests/architecture/ledger-immutability-trigger-metadata.test.mjs`
- update drift/startup/schema guards if the trigger contract or metadata shape changed
