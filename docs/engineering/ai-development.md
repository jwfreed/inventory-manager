# AI-Assisted Development

This repository supports AI-assisted work, but only inside a strict correctness contract.

## Architectural Guardrails

- Ledger is authoritative: `inventory_movements` + `inventory_movement_lines`
- Ledger is append-only
- Deterministic hashing and replay are required
- Projection rebuilds must be ledger-derived

The architecture brief refers to `runInventoryCommand()` and `persistInventoryMovement()`. Those names are not implemented here today. Until a deliberate refactor introduces them, the effective boundaries are:

- transaction shell: `withTransaction(...)` / `withTransactionRetry(...)` in `src/db.ts`
- ledger writer: `createInventoryMovement(...)` / `createInventoryMovementLine(...)` in `src/domains/inventory/internal/ledgerWriter.ts`

## Safe AI Workflow

1. Inspect before editing.
2. Prefer repository-level changes over service-level changes.
3. Do not bypass existing write boundaries.
4. Do not modify schema or migrations unless the user explicitly authorizes schema work.
5. Update docs, manifests, and workflows together when changing test tiers.
6. Report exactly what verification ran.

## Test Tiers

- `npm run test:truth`
  - invariant-only checks and architecture guards
- `npm run test:contracts`
  - representative mutation-family tests
- `npm run test:scenarios`
  - heavy operational and load workflows

Tier manifests live under `tests/truth/`, `tests/contracts/`, and `tests/scenarios/`.

## Prompt Templates

Reusable prompt templates live in:

- `.repo/prompts/safe-repo-change.md`
- `.repo/prompts/ledger-adjacent-change.md`
- `.repo/prompts/test-tier-change.md`

Use them when delegating work to AI tools so the repository contract stays explicit.
