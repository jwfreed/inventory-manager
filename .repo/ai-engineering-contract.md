# AI Engineering Contract

This repository is an inventory-ledger system. AI changes must preserve correctness before convenience.

## Non-Negotiable Invariants

- `inventory_movements` is the authoritative ledger header table.
- `inventory_movement_lines` stores ledger deltas.
- Ledger tables are append-only. Never introduce `UPDATE`, `DELETE`, `TRUNCATE`, trigger disablement, or ownership changes for ledger tables without an explicitly approved migration and matching guard updates.
- Projection rebuilds must recompute from ledger data deterministically and reproduce the same balances for the same `asOf` boundary.
- Deterministic request hashing and replay behavior are part of correctness, not an optimization.

## Current Concrete Entry Points

The product contract mentions `runInventoryCommand()` and `persistInventoryMovement()`. Those names do not currently exist in this repository.

Until an approved architecture refactor introduces them, treat these concrete entry points as the effective equivalents:

- Mutation shell: `src/db.ts`
  - `withTransaction(...)`
  - `withTransactionRetry(...)`
- Ledger write boundary: `src/domains/inventory/internal/ledgerWriter.ts`
  - `createInventoryMovement(...)`
  - `createInventoryMovementLine(...)`
  - `createInventoryMovementLines(...)`

Do not invent alternate ledger writers. Do not write directly to `inventory_movements` or `inventory_movement_lines` outside the owned boundary above.

## Forbidden AI Changes

- Bypassing `withTransaction(...)` / `withTransactionRetry(...)` for multi-step mutations
- Bypassing `createInventoryMovement*` for ledger inserts
- Weakening or deleting truth-suite invariant tests
- Introducing nondeterministic ordering into hashing, replay, or ledger-derived projections
- Modifying schema or migrations without explicit user authorization
- Editing core services to “simplify” ledger correctness paths during unrelated tasks

## Required Verification

For any ledger-adjacent or CI/test-architecture change, run and report the applicable checks:

- `npm run lint:inventory-writes`
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`

If runtime or environment prevents a suite from running, say so explicitly and do not imply it passed.

## Test Tier Policy

- `truth`: invariant-only checks and architecture guards
- `contracts`: representative mutation-family contract tests
- `scenarios`: heavy operational and load workflows

Manifests live in:

- `tests/truth/manifest.json`
- `tests/contracts/manifest.json`
- `tests/scenarios/manifest.json`
