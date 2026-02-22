# Phase 3 Done Done Contract

This contract locks in Phase 3 startup/defaults hardening before Phase 4.1.

## Startup Mode

- `WAREHOUSE_DEFAULTS_REPAIR` is fail-loud by default outside `NODE_ENV=test`.
- Repair is enabled only by explicit opt-in:
  - `--repair-defaults`
  - `WAREHOUSE_DEFAULTS_REPAIR=true`
- Startup logs structured error context when present:
  - `code`
  - `details`

## Test Harness Mode

- `tests/api/helpers/testServer.mjs` always starts server with `--repair-defaults`.
- Harness sets `WAREHOUSE_DEFAULTS_REPAIR=true` if unset.
- Harness lifecycle supports clean restart (`start -> stop -> start -> stop`) with no leaked child process/port.

## Local Dev Stability

- `npm run dev:watch` sets `DEV_AUTO_REPAIR_DEFAULTS=true`.
- Startup config enables auto-repair only when:
  - `NODE_ENV=development`
  - `DEV_AUTO_REPAIR_DEFAULTS=true`
  - `WAREHOUSE_DEFAULTS_REPAIR` is not explicitly set
- Production default remains fail-loud (`WAREHOUSE_DEFAULTS_REPAIR=false` unless explicitly enabled).

## Warehouse Defaults Observability

Event names are stable constants in `src/observability/warehouseDefaults.events.ts`:

- `WAREHOUSE_DEFAULT_ORPHAN_WAREHOUSE_ROOTS_DETECTED`
- `WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRING`
- `WAREHOUSE_DEFAULT_ORPHAN_ROOTS_REPAIRED`
- `WAREHOUSE_DEFAULT_REPAIRING`
- `WAREHOUSE_DEFAULT_REPAIRED`

Payload guards enforce required keys for:

- tenant/warehouse/role identity
- expected vs actual invalid snapshot fields
- orphan counts and bounded samples
- repair counts including `skippedRelinkLocalCodeConflictCount`
- actionable hint (`details.hint`) on defaults startup errors when repair mode is off

## Correctness Guardrails

Defaults/startup/harness modules must not import or call correctness-critical paths for:

- ledger posting
- cost layer costing
- availability recomputation

Architecture tests enforce these boundaries.
