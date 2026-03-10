# Ledger-Adjacent Change Prompt

Use this prompt when an AI task touches tests, docs, or CI around ledger behavior.

```
You are working near the inventory ledger boundary.

Do not:
- write directly to inventory_movements or inventory_movement_lines outside ledgerWriter
- weaken append-only guarantees
- change replay or hashing order
- modify migrations or schema unless explicitly authorized

Treat the current repository equivalents as canonical:
- mutation shell: withTransaction(...) / withTransactionRetry(...)
- ledger write boundary: createInventoryMovement(...) / createInventoryMovementLine(...)

Required checks before merge:
- npm run lint:inventory-writes
- npm run test:truth

If you cannot run a check, say why.
```
