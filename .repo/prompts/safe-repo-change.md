# Safe Repository Change Prompt Template

Use this template when delegating any repository change to an AI tool.

---

## Context

Repository: inventory-manager
Change type: [describe the change]
Files affected: [list affected files]

## Invariant Constraints

Before making any change, confirm:

- The ledger (`inventory_movements` + `inventory_movement_lines`) remains append-only.
- All writes go through `createInventoryMovement` / `createInventoryMovementLine` in `ledgerWriter.ts`.
- All mutations are wrapped in `withTransaction` or `withTransactionRetry`.
- No schema or migration changes unless explicitly authorized.
- Deterministic hash computation (`buildMovementDeterministicHash`) is not altered or duplicated.
- Replay logic and execution logic share the same code path.

## Task Description

[Describe the specific task here]

## Verification Required

After the change:
- `npm run lint:inventory-writes`
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`

Report what ran and what passed.
