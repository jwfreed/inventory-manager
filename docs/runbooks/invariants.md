# Invariants Runbook

This system treats inventory correctness as a first-class safety constraint. Invariants are checks that must hold across ledger, warehouse hierarchy, and reservations. When invariants fail, the system **fails fast** or blocks unsafe actions instead of silently repairing data.

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

- Warehouses: `docs/runbooks/warehouses.md`
- CI/testing workflow: `docs/runbooks/ci.md`
- Debugging tests: `docs/runbooks/debugging_tests.md`
