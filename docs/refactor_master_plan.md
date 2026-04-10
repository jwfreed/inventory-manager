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

> **Current-State Assumption** = observed or schema-enforced behavior, not guaranteed to be universally applied across all workflows. **Target-State Invariant** = required outcome; the refactor must achieve and preserve this.

- **Target-State Invariant:** Authoritative inventory state is stored exclusively in ledger tables (`inventory_movements`, `inventory_movement_lines`). No other table is the source of truth for inventory correctness.
- **Current-State Assumption:** Ledger tables are append-only (enforced by schema). This constraint must not be weakened.
- **Target-State Invariant:** Derived state (e.g., `inventory_balance`) is a projection only. It must never be used as the source of truth for correctness decisions.
- **Target-State Invariant:** No workflow may read a projection to validate a mutation. Validation must use authoritative ledger state or explicit domain invariants.
- **Current-State Assumption:** State transitions are represented as movement records, not as in-place updates.

## 3.2 Execution Model

The intended execution path for every inventory command follows this sequence:

```
Command input
  → Validation (against authoritative state and domain invariants)
  → Lock acquisition (via acquireAtpLocks, inside transaction)
  → Ledger write (via createInventoryMovement / createInventoryMovementLine)
  → Projection update (derived, not authoritative)
```

- **Target-State Invariant:** All steps within a single command execute inside a single `withTransaction` / `withTransactionRetry` boundary. No step may be skipped or reordered.
- **Current-State Assumption (Transfers only):** All transfer commands are routed through `runInventoryCommand` in `src/modules/platform/application/runInventoryCommand.ts`. No parallel entry points exist for transfers as of Sprint 1.
- **Target-State Invariant:** `runInventoryCommand` is the single enforced entry point for all inventory commands. No parallel execution paths are permitted in the post-refactor state.
- **Current-State Assumption:** QC and WorkOrder workflows may retain additional or alternate entry points. These must be identified and closed as part of Sprint 2 and Sprint 3+ respectively.

## 3.3 Replay Model

- **Target-State Invariant:** Replay is system-wide, not local to a single workflow. A full-system replay over the complete ledger must reproduce the same derived state as the original execution.
- **Current-State Assumption:** Replay ordering uses `buildMovementDeterministicHash` and `sortDeterministicMovementLines` in `src/modules/platform/application/inventoryMovementDeterminism.ts`. This ordering must not be altered.
- **Target-State Invariant:** Replay must be idempotent: replaying the same set of movements any number of times must produce the same result.
- **Target-State Invariant:** Replay and execution share the same logic path. No parallel replay implementation is permitted.
- **Target-State Invariant:** Movements from different workflows must not interfere with full-system replay. Workflow logic must not depend on hidden control flow of other workflows.

### Global Replay Assumptions

- **Target-State Invariant:** The ledger is the sole input to replay. No external state, projections, or ambient context may be consulted.
- **Current-State Assumption:** Hash computation uses `buildMovementDeterministicHash`. Same inputs must always produce the same hash; this function must not be modified or duplicated.
- **Current-State Assumption:** Line ordering within a movement uses `sortDeterministicMovementLines`. This is the sole ordering function; it must not be modified or duplicated.
- **Target-State Invariant:** Idempotency is enforced via `claimTransactionalIdempotency` on every ledger-affecting mutation path. Coverage must be verified per workflow; do not assume universal enforcement.

### Cross-Workflow Replay Safety Constraints

- **Target-State Invariant:** A full-system replay consumes the union of all ledger movements. Replay logic must produce the same derived state from the complete ledger as produced by the original execution sequence.
- **Target-State Invariant:** Workflow logic must not depend on hidden control flow of other workflows. A workflow's execution path must be understandable and verifiable without tracing another workflow's implementation.
- **Target-State Invariant:** No movement may encode a dependency on another workflow's uncommitted or in-flight state.
- **Target-State Invariant:** If two workflows share a projection (e.g., `inventory_balance`), the projection must be derivable from the full ledger. No workflow requires private or isolated replay to produce a correct projection contribution.

## 3.4 Transaction Model

- **Target-State Invariant:** Each inventory command executes within exactly one transaction boundary (`withTransaction` or `withTransactionRetry`).
- **Target-State Invariant:** Lock acquisition occurs inside the transaction, before any write.
- **Current-State Assumption:** Ledger writes are atomic at the DB level: a movement and all its lines commit together or not at all (enforced by transaction semantics).
- **Target-State Invariant:** No cross-workflow transaction is permitted. Workflows must not mutate shared state within a single transaction boundary unless that shared state is the ledger itself.
- **Target-State Invariant:** Partial state (a movement without its lines, or a lock without a write) must never be committed.

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

Each workflow must have a single, explicit ownership boundary:
- One authoritative code location owns the execution path for each workflow.
- Unrelated workflows must not be co-located in the same module.
- Shared infrastructure (e.g., the ledger writer, the transaction shell) is permitted only if it is workflow-agnostic and contains no workflow-specific logic.

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
- Core correctness boundaries identified; detailed QC workflow definition deferred to Sprint 2 Phase A.
- Transfer workflow boundary fully explicit (source of truth, invariants, replay contract).
- QC and WorkOrder workflows identified as containing mixed boundaries and partial correctness; detailed definition is Sprint 2 Phase A work.

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
4. **Single ownership boundary per workflow.** Each workflow must have one authoritative code location. Unrelated workflows must not be co-located. Shared infrastructure is permitted only if workflow-agnostic.
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

| Check | Existence | Required at |
|-------|-----------|-------------|
| `npm run test:truth` | Must verify existence | Every sprint boundary |
| `npm run test:contracts` | Must verify existence | Every sprint boundary |
| `npm run lint:inventory-writes` | Must verify existence | Every sprint boundary |

> These checks are required at each sprint boundary. Their existence and enforcement must be verified in the codebase. Do not assume availability or passing status without explicit confirmation.

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
| 2026-04-10 | Introduce classification labels (Current-State Assumption / Target-State Invariant) in §3 and §4 | Absolute claims were unverified; labeling separates current state from required outcomes |
| 2026-04-10 | Relax cross-workflow replay constraint | Requiring per-workflow independent replay was too strong; full-system replay consuming union of all movements is the correct model |
| 2026-04-10 | Replace single-module rule with ownership boundary rule in §4 and §10 | Structural rigidity of "one workflow per module" would have forbidden shared infrastructure; ownership boundary preserves intent |
| 2026-04-10 | Correct Sprint 0.5 exit criteria | Overstated completeness; QC workflow definition is deferred to Sprint 2 Phase A |
