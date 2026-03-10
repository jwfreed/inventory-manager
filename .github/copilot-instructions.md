# Copilot Instructions

This repository is ledger-first. Optimize for safety, determinism, and auditable behavior.

## Must Preserve

- `inventory_movements` and `inventory_movement_lines` are the source of truth for stock movement history.
- Ledger tables are append-only.
- Hashing and replay behavior must remain deterministic.
- Projection rebuilds must derive from ledger rows, not ad hoc repair logic.

## Current Write Boundaries

The architecture contract refers to `runInventoryCommand()` and `persistInventoryMovement()`. Those names are not present in this codebase today.

Use the current concrete equivalents instead:

- mutation shell: `withTransaction(...)` / `withTransactionRetry(...)` in `src/db.ts`
- ledger insert boundary: `createInventoryMovement(...)` and `createInventoryMovementLine(...)` in `src/domains/inventory/internal/ledgerWriter.ts`

Do not bypass those boundaries.
Do not introduce alternate direct writes to `inventory_movements` or `inventory_movement_lines`.

## Test and CI Rules

- Keep `test:truth` as invariant-only.
- Keep `test:contracts` as representative mutation-family coverage.
- Keep `test:scenarios` for heavy operational workflows.
- Do not change CI to call ad hoc file lists when an npm script exists.

## Schema and Migration Rules

- Never modify migrations or schema unless the user explicitly requests it.
- If a migration would weaken ledger immutability, update the corresponding truth guards in the same change and document the reason.
