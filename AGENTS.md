# AGENTS.md — Canonical Source of Truth

This file is the single authoritative reference for all AI agents operating on this repository.
Agent-specific overlays (`CLAUDE.md`, `CODEX.md`, `.github/copilot-instructions.md`) **must reference this file** and must not redefine rules declared here.

---

## Role

All agents operate as domain-aware inventory systems engineers. This codebase is correctness-critical. The job is to make the smallest safe change that satisfies the stated requirement — nothing more.

---

## Domain Invariants

- Inventory truth must stay reconcilable between physical stock and recorded stock.
- Inventory states must remain explicit and must not be implied by convenience fields or shortcuts.
- Quantity meanings are distinct and non-interchangeable: `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, `consumed`.
- Receiving, acceptance, putaway, storage, allocation, picking, transfer, shipping, counting, quarantine, and adjustment are distinct workflows.
- Quantity-affecting changes must remain auditable over time.
- UI must reflect operational truth, including blocked states and partial completion.
- When in doubt about domain semantics, `docs/domain-invariants.md` is the human source of truth.

---

## Architecture Rules

### Ledger Immutability
- `inventory_movements` and `inventory_movement_lines` are append-only. Never update or delete rows.
- All writes must go through `createInventoryMovement()` and `createInventoryMovementLine()` in `src/domains/inventory/internal/ledgerWriter.ts`.
- No alternate write paths to ledger tables are permitted.

### Write Boundaries
- Mutation shell: `withTransaction(...)` / `withTransactionRetry(...)` in `src/db.ts`.
- Ledger insert boundary: `createInventoryMovement(...)` / `createInventoryMovementLine(...)` in `src/domains/inventory/internal/ledgerWriter.ts`.
- Higher-level orchestration: `runInventoryCommand(...)` in `src/modules/platform/application/runInventoryCommand.ts`.
- Do not bypass any of these boundaries.

### Single Canonical Logic Path
- Replay logic and execution logic must share the same implementation.
- Do not maintain parallel implementations of the same invariant.
- Do not duplicate movement validation, hash computation, or quantity derivation.

### Deterministic Hashing
- `buildMovementDeterministicHash` and `sortDeterministicMovementLines` in `src/modules/platform/application/inventoryMovementDeterminism.ts` are the only permitted hash/sort functions for movement identity.
- Do not add alternate hash implementations or sort orderings.

### Lock Discipline
- ATP locks are acquired via `acquireAtpLocks(...)` with an `AtpLockContext`.
- Lock acquisition must precede any quantity-affecting mutation within a transaction.
- Do not acquire locks outside of the transaction boundary.

### Domain Ownership
- Only the Inventory domain may write inventory ledger/balance tables.
- Cross-domain writes are forbidden. See `ARCHITECTURE.md` for the full write ownership table.
- The static guard at `scripts/check-inventory-writes.ts` enforces this at CI time.

### Projection Rebuilds
- Projections must derive exclusively from ledger rows.
- Ad hoc repair logic that writes derived state without reading the ledger is forbidden.

### Idempotency
- All inventory mutations must be idempotent.
- Idempotency keys must be declared and claimed via `claimTransactionalIdempotency` before any side-effecting work.

---

## Forbidden Changes

- Bypassing `withTransaction(...)` / `withTransactionRetry(...)` for multi-step mutations.
- Bypassing `createInventoryMovement*` for ledger inserts.
- Weakening or deleting truth-suite invariant tests.
- Introducing nondeterministic ordering into hashing, replay, or projections.
- Modifying schema or migrations without explicit user authorization.
- Editing core services to "simplify" ledger correctness during unrelated tasks.

---

## Schema and Migration Rules

- Never modify migrations or schema unless the user explicitly requests it.
- If a migration would weaken ledger immutability, update the corresponding truth guards in the same change and document the reason.

---

## Test Tier Policy

| Tier | Scope | Command |
|------|-------|---------|
| `truth` | Invariant-only checks and architecture guards | `npm run test:truth` |
| `contracts` | Representative mutation-family contract tests | `npm run test:contracts` |
| `scenarios` | Heavy operational and load workflows | `npm run test:scenarios` |

- Do not move a test between tiers without justification.
- Do not remove truth coverage for ledger immutability, migration lint, idempotency, or invariant drift.
- Do not add CI commands that are not backed by npm scripts.

Required verification for ledger-adjacent or CI/test changes:
- `npm run lint:inventory-writes`
- `npm run test:truth`
- `npm run test:contracts`
- `npm run test:scenarios`

If a suite cannot run, say so explicitly and do not imply it passed.

---

## Skill Execution Contract

- Before any non-trivial task, inspect `.skills/` and identify every applicable skill.
- Skills are required, not optional. If a skill applies, it must be executed.
- Multiple applicable skills must all be executed.
- Do not begin implementation until all OUTPUT SCHEMAs are complete.

### Skill Routing

- `inventory-domain-guardrails` — inventory meaning, state transitions, movement semantics, reconciliation, UOM, location truth, auditability.
- `inventory-implementation-planner` — multi-layer work, workflow scope changes, migrations, reporting, refactors with behavioral risk.
- `inventory-review-checklist` — self-review, PR review, acceptance review on inventory changes.
- `inventory-test-strategy` — adding/changing tests for quantity-affecting behavior, failure paths, concurrency, migration safety.
- `inventory-ui-flow-guardrails` — frontend labels, action gating, workflow screens, status mappings, UI behavior affecting operator understanding.

---

## Conflict Resolution

- If documents disagree on domain meaning, `docs/domain-invariants.md` wins.
- If a skill and a generic coding instinct disagree, the skill wins.
- If a task spans several risk areas, combine the relevant skills.

---

## Default Workflow

1. Read relevant files and trace affected code paths.
2. Identify and execute all applicable `.skills/`.
3. Complete all OUTPUT SCHEMAs before writing code.
4. Keep the change tightly scoped to the requested behavior.
5. Preserve write boundaries, movement auditability, and state explicitness.
6. Add or update tests that prove workflow integrity and failure handling.
7. Report what changed, what was verified, and remaining risk.

---

## Verification Checklist

Before finalizing any change, confirm:

- [ ] All affected invariants are preserved.
- [ ] No ledger table was written outside `ledgerWriter.ts`.
- [ ] No `withTransaction` / `withTransactionRetry` boundary was bypassed.
- [ ] Replay and execution still share the same logic path.
- [ ] Deterministic hash computation was not altered or duplicated.
- [ ] No quantity semantics were conflated or redefined.
- [ ] No unrelated files were modified.
- [ ] No speculative improvements were introduced.
- [ ] All applicable skills were executed and OUTPUT SCHEMAs completed.
- [ ] Failure modes are addressed.

If any item fails, the task is incomplete.
