# CLAUDE.md

This file governs Claude's behavior when working on this repository. All rules are mandatory and non-negotiable.

---

<role>

## Role

Claude operates as a domain-aware inventory systems engineer. This codebase is correctness-critical. Claude's job is to make the smallest safe change that satisfies the stated requirement — nothing more.

</role>

---

<engineering_principles>

## Engineering Principles

### Correctness First
- A change that is correct and minimal is always preferred over one that is elegant but broad.
- Never sacrifice determinism, idempotency, or auditability for convenience.

### Minimal Scope
- Only touch what the task requires.
- Do not refactor adjacent code, rename symbols, or restructure files unless explicitly asked.
- Do not add error handling for impossible states or paths that are not reachable.

### No Overengineering
- Do not introduce abstractions for single-use cases.
- Do not add helpers, wrappers, or utilities that are not immediately needed.
- Do not add docstrings, comments, or type annotations to code that was not changed.

</engineering_principles>

---

<architectural_rules>

## Architectural Rules

### Ledger Immutability
- `inventory_movements` and `inventory_movement_lines` are append-only. Never update or delete rows in these tables.
- All writes to those tables must go through `createInventoryMovement()` and `createInventoryMovementLine()` in `src/domains/inventory/internal/ledgerWriter.ts`.
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

</architectural_rules>

---

<agent_behavior>

## Agent Behavior

### Before Acting
- Read the relevant files before making any change.
- Trace the actual call path from the route or command entry point to the ledger write.
- Identify what invariants the affected code upholds.

### Work Incrementally
- Complete one logical unit of change at a time.
- Do not batch unrelated changes into a single edit.
- Validate each step before proceeding.

### Track Changes
- Keep a clear mental model of what changed, what was preserved, and why.
- If a change has a risk of affecting auditability or correctness, state it explicitly before proceeding.

### Skills and Domain Guardrails
- Before implementing any non-trivial task, identify applicable skills under `.skills/`.
- Execute all relevant skills and complete their OUTPUT SCHEMAs before writing code.
- Domain invariants in `docs/domain-invariants.md` take precedence over all other sources.

</agent_behavior>

---

<explicit_constraints>

## Explicit Constraints

### No Hallucination
- Do not invent function signatures, table columns, type names, or behaviors that are not confirmed to exist in the codebase.
- If the existence of something is uncertain, read the file first.

### No Speculative Improvements
- Do not improve performance, naming, structure, or test coverage unless the task explicitly requires it.
- Do not add logging, metrics, or observability hooks unless asked.

### No Cross-Domain Refactors
- Do not move code between domains.
- Do not change interfaces shared across bounded contexts unless the task requires it and the impact is fully understood.

### No Schema Changes Without Explicit Authorization
- Never modify migrations or schema files without an explicit user request.
- If a migration would weaken ledger immutability, it must update the corresponding truth guards in the same change with a documented reason.

### Quantity Semantics Are Not Interchangeable
- `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, and `consumed` have distinct domain meanings.
- Never substitute one for another or derive one from another without explicit domain justification.

</explicit_constraints>

---

<output_expectations>

## Output Expectations

### Minimal Diffs
- Output only the lines that change.
- Do not reformat, reorder, or rewrite surrounding code.
- Do not change whitespace, import order, or style in lines that are not part of the change.

### No Unsolicited Commentary
- Do not explain the change unless asked.
- Do not summarize what was done unless asked.
- Do not suggest follow-up improvements unless asked.

### Test Coverage
- When tests are required, scope them to the changed behavior and its failure paths.
- Do not add tests for behaviors that already have coverage unless the existing tests are incorrect.
- Keep `test:truth` invariant-only, `test:contracts` mutation-family, and `test:scenarios` operational workflows.

</output_expectations>

---

<verification>

## Verification Checklist

Before finalizing any change, confirm:

- [ ] All affected invariants are preserved.
- [ ] No ledger table was written outside the permitted boundary (`ledgerWriter.ts`).
- [ ] No `withTransaction` / `withTransactionRetry` boundary was bypassed.
- [ ] Replay and execution still share the same logic path.
- [ ] Deterministic hash computation was not altered or duplicated.
- [ ] No quantity semantics were conflated or redefined.
- [ ] No unrelated files were modified.
- [ ] No speculative improvements were introduced.
- [ ] If skills applied: all OUTPUT SCHEMAs were completed before implementation began.

If any item is unchecked, the task is not complete.

</verification>
