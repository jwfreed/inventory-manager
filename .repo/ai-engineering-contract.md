# AI Engineering Contract

This document encodes the invariants that all AI agents must uphold when operating on this repository.
It is referenced by `AGENTS.md` and enforced by the `truth` test tier.

---

## Ledger Immutability

- `inventory_movements` and `inventory_movement_lines` are append-only. No UPDATE or DELETE is permitted on these tables.
- All ledger writes must go through `createInventoryMovement` and `createInventoryMovementLine` in `src/domains/inventory/internal/ledgerWriter.ts`.
- No alternate write paths to ledger tables are permitted.

## Mutation Shell

- All multi-step mutations must be wrapped in `withTransaction` or `withTransactionRetry` from `src/db.ts`.
- Bypassing `withTransaction` / `withTransactionRetry` is forbidden.
- Lock acquisition must occur inside the transaction boundary, before any quantity-affecting mutation.

## Determinism and Idempotency

- Movement identity hashing uses `buildMovementDeterministicHash` and `sortDeterministicMovementLines` in `src/modules/platform/application/inventoryMovementDeterminism.ts`.
- All ledger-affecting mutations must be idempotent via `claimTransactionalIdempotency`.
- Replay logic and execution logic must share the same implementation. No parallel paths.

## Schema Rules

- Never modify schema or migrations without explicit user authorization.
- If a migration would weaken ledger immutability, the corresponding truth guards must be updated in the same change.

## Test Tier Contract

- `truth` — invariant-only checks and architecture guards
- `contracts` — representative mutation-family tests
- `scenarios` — heavy operational and load workflows

Required verification for ledger-adjacent changes:
- `npm run lint:inventory-writes`
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`

## Domain Ownership

- Only the Inventory domain may write inventory ledger and balance tables.
- Cross-domain writes are forbidden.
- The static guard at `scripts/check-inventory-writes.ts` enforces this at CI time.
