# Ledger-Adjacent Change Prompt Template

Use this template when making any change that touches the inventory ledger, balance tables,
movement processing, or write boundaries.

---

## Context

Repository: inventory-manager
Change type: ledger-adjacent
Files affected: [list affected files]

## Ledger Invariant Checklist

Before proceeding:

- [ ] Confirm `inventory_movements` and `inventory_movement_lines` remain append-only.
- [ ] Confirm all ledger writes go through `createInventoryMovement` / `createInventoryMovementLine`.
- [ ] Confirm `withTransaction` / `withTransactionRetry` wraps all multi-step mutations.
- [ ] Confirm deterministic hash (`buildMovementDeterministicHash`) is not duplicated or modified.
- [ ] Confirm idempotency is preserved (`claimTransactionalIdempotency`).
- [ ] Confirm schema is not modified unless explicitly authorized.
- [ ] Confirm replay correctness: replay and execution share the same logic path.

## Quantity Semantics

Quantity types are distinct and non-interchangeable:
`on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, `consumed`.

Do not conflate or reassign quantity meaning.

## Task Description

[Describe the specific ledger-adjacent task here]

## Verification Required

- `npm run lint:inventory-writes`
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`
