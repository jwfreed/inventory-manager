# Refactoring Master Plan — Inventory Manager

## Purpose
Single source of truth for refactoring progress, decisions, and safety constraints.

---

# 1. Current Status Dashboard

- Phase: Sprint-Based Refactor
- Current Sprint: Sprint 2 (QC Separation)
- Status: In Progress

| Sprint | Description | Status |
|--------|-------------|--------|
| Sprint 0 | Risk mapping and findings | Complete |
| Sprint 0.5 | Correctness boundary definition | Complete |
| Sprint 1 | Transfers boundary hardening + decomposition | **Complete** |
| Sprint 2 | QC separation | **In Progress** |
| Sprint 3+ | WorkOrder decomposition | Not started |

---

# 2. Targets

| Target | Status | Notes |
|--------|--------|-------|
| Transfers | Complete | Boundary enforced, decomposition done |
| QC | In Progress | Workflow mixing, boundary definition underway |
| WorkOrderExecution | Not started | High risk, multi-workflow, blocked on QC patterns |

---

# 3. System Model Definition

This section establishes the authoritative system model that all refactoring work must preserve.

## 3.1 State Model

- **Authoritative state** is stored exclusively in ledger tables (`inventory_movements`, `inventory_movement_lines`). These are append-only.
- **Derived state** (e.g., `inventory_balance`) is a projection. It must never be used as the source of truth for correctness decisions.
- No workflow may read a projection to validate a mutation. Validation must use authoritative ledger state or explicit domain invariants.
- State transitions are represented as movement records, not as in-place updates.

## 3.2 Execution Model

The execution path for every inventory command follows this sequence:

```
Command input
  → Validation (against authoritative state and domain invariants)
  → Lock acquisition (via acquireAtpLocks, inside transaction)
  → Ledger write (via createInventoryMovement / createInventoryMovementLine)
  → Projection update (derived, not authoritative)
```

- All steps within a single command execute inside a single `withTransaction` / `withTransactionRetry` boundary.
- No step may be skipped. No step may be reordered.
- The entry point for all inventory commands is `runInventoryCommand` in `src/modules/platform/application/runInventoryCommand.ts`. No parallel entry points are permitted.

## 3.3 Replay Model

- **Replay is system-wide**, not local to a single workflow. A replay over the full ledger must reproduce the same derived state as the original execution.
- Replay ordering is determined by `buildMovementDeterministicHash` and `sortDeterministicMovementLines` in `src/modules/platform/application/inventoryMovementDeterminism.ts`. This ordering must not be altered.
- Replay must be idempotent: replaying the same set of movements any number of times must produce the same result.
- Replay and execution share the same logic path. No parallel replay implementation is permitted.
- Cross-workflow replay safety: movements from different workflows (e.g., Transfer and QC) must not interfere with each other during replay. Each workflow's movements are logically isolated and must produce correct state independently.

### Global Replay Assumptions

- The ledger is the sole input to replay. No external state, projections, or ambient context may be consulted.
- Hash computation is deterministic: same inputs always produce the same hash.
- Line ordering within a movement is deterministic: `sortDeterministicMovementLines` is the sole ordering function.
- Idempotency is enforced via `claimTransactionalIdempotency` on every ledger-affecting mutation path.

### Cross-Workflow Replay Safety Constraints

- A workflow's movements must be self-contained. A replay of workflow A must not require reading movements from workflow B.
- No movement may encode a dependency on another workflow's uncommitted or in-flight state.
- If two workflows share a projection (e.g., `inventory_balance`), each workflow's replay must produce a correct projection contribution in isolation; the combined projection is derived by union.

## 3.4 Transaction Model

- Each inventory command executes within exactly one transaction boundary (`withTransaction` or `withTransactionRetry`).
- Lock acquisition occurs inside the transaction, before any write.
- Ledger writes are atomic: a movement and all its lines commit together or not at all.
- No cross-workflow transaction is permitted. Workflows must not mutate shared state within a single transaction boundary unless that shared state is the ledger itself.
- Partial state (a movement without its lines, or a lock without a write) must never be committed.

---

# 4. Workflow Definition

A **workflow** is a named, bounded domain operation that transforms inventory state through a single execution path. Workflows are the unit of refactoring.

Every workflow must be explicitly defined with the following properties:

| Property | Description |
|----------|-------------|
| **Inputs** | The command or trigger and its required parameters |
| **Outputs** | The ledger records written; the projections updated |
| **Authoritative state** | The ledger table(s) that own correctness for this workflow |
| **Invariants** | The domain rules that must hold before and after execution |
| **Execution path** | The concrete code path from command entry to ledger write |
| **Replay contract** | What a correct replay of this workflow's movements must produce |
| **Transaction boundary** | Where `withTransaction` begins and ends for this workflow |

Workflows identified in this codebase:

- **Transfer** — movement of inventory between locations
- **Receipt QC** — quality inspection of received goods
- **Work Order QC** — quality inspection within a work order
- **Execution/Disposition QC** — QC disposition decisions affecting inventory state
- **Work Order Execution** — material issue, backflush, WIP tracking

Each workflow must be contained within a single module. No module may contain more than one workflow.

---

# 5. Sprint 0 Findings

## Key Risks

### Projection Leakage
- Derived state used in correctness decisions
- Violates source-of-truth principles

### Replay Fragility
- Multiple replay paths
- Inconsistent idempotency mechanisms

### Workflow Mixing
- Multiple workflows in single services
- Implicit domain boundaries

### Transaction Splitting
- Non-atomic operations
- Partial state risk

---

# 6. Sprint 0.5 — Correctness Boundary Definition

## Status: Complete

## Goal
Make correctness explicit before refactoring.

### Tasks
- [x] Identify authoritative writes per workflow
- [x] Identify projection dependencies
- [x] Define replay contract per workflow
- [x] Identify invariant enforcement points
- [x] Flag cross-transaction risks

### Exit Criteria — Met
- All workflows have explicit source of truth, invariants, and replay definition.

---

# 7. Sprint 1 — Transfers Boundary Hardening + Decomposition

## Status: **Complete**

### Goal
Make the transfer correctness boundary explicit and non-bypassable, then begin safe decomposition.

### Tasks

#### Boundary Hardening
- [x] Define and enforce single execution path (`runInventoryCommand`)
- [x] Identify and restrict unsafe entry points
- [x] Make replay verification deterministic (remove conditional paths)
- [x] Document projection dependency (`inventory_balance`)

#### Decomposition
- [x] Extract transfer events
- [x] Extract replay logic
- [x] Separate orchestration from domain logic

### Exit Criteria — Met
- All transfer mutations go through one enforced path
- Replay is deterministic and consistent
- Projection dependency is explicit and documented
- Orchestration layer is thinner
- No behavioral change

---

# 8. Sprint 2 — QC Separation

## Status: **In Progress**

### Goal
Separate QC domain concerns into distinct, explicitly bounded workflows. Each QC workflow must have an authoritative execution path, explicit invariants, and a defined replay contract before any code is moved.

---

## Phase A — Boundary Definition (MUST COMPLETE BEFORE ANY REFACTOR)

The purpose of this phase is to make existing QC correctness explicit, not to change it.

### A.1 Authoritative Writes per QC Workflow

For each QC workflow listed below, identify and document:
- Which ledger tables are written
- Which `createInventoryMovement` / `createInventoryMovementLine` call sites are used
- Which projection tables are updated as a result

Workflows in scope:
- Receipt QC (inspection of inbound goods at receiving)
- Work Order QC (inspection within a work order context)
- Execution/Disposition QC (disposition decisions that affect inventory state)

Deliverable: A written mapping of workflow → write sites → projections. No code changes until this is complete.

### A.2 Invariants per QC Workflow

For each QC workflow, define:
- Preconditions (what must be true before execution)
- Postconditions (what must be true after execution)
- Domain rules that must not be violated (e.g., a quarantined item cannot be allocated)

Deliverable: Explicitly stated invariant list per workflow, cross-referenced against `docs/domain-invariants.md`.

### A.3 Replay Contract per QC Workflow

For each QC workflow, define:
- What movements are written and in what order
- What a correct replay of those movements must produce
- Whether any QC movement depends on state written by another workflow

Deliverable: A replay contract statement per workflow, consistent with the global replay assumptions in §3.3.

### A.4 Transaction Boundaries

For each QC workflow, identify:
- Where `withTransaction` / `withTransactionRetry` begins and ends
- Whether any QC workflow currently spans multiple transactions (a risk that must be resolved before separation)
- Whether lock acquisition precedes writes in all paths

Deliverable: Transaction boundary diagram or table per workflow.

### A.5 Projection Dependencies

Identify all projections read or written by QC workflows, including:
- `inventory_balance` (if applicable)
- Any QC-specific derived tables
- Any projection currently used in correctness decisions (this is a violation and must be flagged)

Deliverable: Projection dependency map per workflow, with violations flagged.

### A.6 Forbidden Cross-Workflow Access

Define explicitly what QC workflows must not do:
- Must not read another workflow's in-flight ledger state
- Must not write to ledger tables outside the QC workflow's authoritative scope
- Must not depend on projection state for correctness decisions
- Must not share a transaction boundary with a non-QC workflow

Deliverable: A written list of forbidden access patterns, enforced as invariants during Phase B.

---

## Phase B — Separation (AFTER PHASE A IS COMPLETE)

### B.1 Split Receipt QC
- Extract receipt QC into its own module
- Enforce a single execution path through `runInventoryCommand`
- Verify replay contract is preserved post-split

### B.2 Split Work Order QC
- Extract work order QC into its own module
- Ensure no shared state or transaction boundary with receipt QC
- Verify replay contract is preserved post-split

### B.3 Split Execution/Disposition QC
- Extract execution and disposition QC into its own module
- Ensure disposition logic does not read projection state for correctness
- Verify all disposition paths write through `createInventoryMovement*`

### B.4 Isolate Disposition Logic
- Disposition decisions (accept, reject, quarantine, rework) must be contained within the disposition QC workflow
- No other workflow may invoke or depend on disposition logic directly

### B.5 Separate Orchestration from Domain Logic
- Orchestration (sequencing, routing, error handling) must be separated from domain logic (invariant validation, ledger writes)
- Domain logic must be callable independently of orchestration for replay purposes

---

## Sprint 2 Exit Criteria

All of the following must be true before Sprint 2 is considered complete:

- [ ] Each QC workflow has an explicitly documented authoritative write path
- [ ] Each QC workflow has an explicitly stated invariant set, cross-referenced against `docs/domain-invariants.md`
- [ ] Each QC workflow has a defined replay contract consistent with global replay assumptions
- [ ] Each QC workflow executes within a single atomic transaction boundary
- [ ] No QC workflow reads a projection for a correctness decision
- [ ] No QC workflow shares a transaction boundary with a non-QC workflow
- [ ] Cross-workflow leakage (shared state, shared transaction, shared write path) is removed
- [ ] Replay over the full ledger after separation produces the same derived state as before separation
- [ ] No behavioral change: existing QC outcomes are identical before and after refactor
- [ ] All invariant-tier tests (`npm run test:truth`) pass without modification

---

# 9. Sprint 3+ — WorkOrder Decomposition

## Status: Not Started

### Goal
Safely decompose the WorkOrderExecution monolith.

### Preconditions
- Transfers pattern proven (Sprint 1 complete — met)
- QC separation pattern proven (Sprint 2 complete — pending)
- Correctness boundaries defined for all QC workflows

### Notes
- WorkOrderExecution is the highest-risk target: multi-workflow, highest write surface
- Do not begin until QC separation exit criteria are fully met

---

# 10. Refactor Rules

These rules apply to all sprints without exception.

1. **No behavioral changes.** Refactoring must not alter observable outcomes for any workflow.
2. **No projection-based correctness.** Projections are never the source of truth. Validation uses authoritative ledger state only.
3. **Replay must remain deterministic.** Ordering and idempotency guarantees defined in §3.3 must be preserved.
4. **One workflow per module.** No module may contain logic for more than one workflow.
5. **Preserve invariants.** All domain invariants defined in `docs/domain-invariants.md` must hold before and after every change.
6. **Boundary-first.** No separation work begins until the correctness boundary is explicitly defined and documented.
7. **No alternate write paths.** All ledger writes go through `createInventoryMovement` / `createInventoryMovementLine`.
8. **No transaction bypass.** All multi-step mutations use `withTransaction` / `withTransactionRetry`.

---

# 11. Metrics

## Structural
- Workflows explicitly defined and isolated (target: all workflows in scope)
- Modules containing more than one workflow (target: 0)

## Correctness
- Replay failures after refactor: 0
- Invariant violations after refactor: 0
- Projection-based correctness decisions remaining: 0

## Verification
- `npm run test:truth` passes: required at every sprint boundary
- `npm run test:contracts` passes: required at every sprint boundary
- `npm run lint:inventory-writes` passes: required at every sprint boundary

---

# 12. Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-09 | Start with Transfers | Lowest risk, strongest existing boundary |
| 2026-04-09 | Add Sprint 0.5 | Correctness must precede refactor |
| 2026-04-09 | Add boundary hardening to Sprint 1 | Prevent correctness regressions during decomposition |
| 2026-04-10 | Add System Model Definition (§3) | Replay and execution model were implicit; made explicit to prevent drift |
| 2026-04-10 | Add Workflow Definition (§4) | "Workflow" was used without a formal definition; first-class status required for Sprint 2+ |
| 2026-04-10 | Rewrite Sprint 2 as two-phase (boundary-first, then separation) | Phase A prevents correctness regressions during QC separation |
| 2026-04-10 | Define global replay assumptions and cross-workflow safety constraints | Local replay definition was insufficient for multi-workflow system |
