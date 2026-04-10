# Copilot Instructions

> **Source of truth: `AGENTS.md`**
> This file is a thin overlay for GitHub Copilot. All invariants, architecture rules, and domain constraints live in `AGENTS.md`.

## Ledger Safety

- `inventory_movements` and `inventory_movement_lines` are append-only.
- All writes go through `createInventoryMovement(...)` and `createInventoryMovementLine(...)` in `src/domains/inventory/internal/ledgerWriter.ts`.
- Mutation shell: `withTransaction(...)` / `withTransactionRetry(...)` in `src/db.ts`.
- Do not bypass these boundaries or introduce alternate direct writes.

## Test and CI Rules

- Keep `test:truth` as invariant-only.
- Keep `test:contracts` as representative mutation-family coverage.
- Keep `test:scenarios` for heavy operational workflows.
- Do not change CI to call ad hoc file lists when an npm script exists.

## Schema Rules

- Never modify migrations or schema unless the user explicitly requests it.
- If a migration would weaken ledger immutability, update the corresponding truth guards in the same change and document the reason.
