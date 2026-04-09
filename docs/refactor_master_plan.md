# Refactoring Master Plan — Inventory Manager

## Purpose
Single source of truth for refactoring progress, decisions, and safety constraints.

---

# 1. Current Status Dashboard

- Phase: Sprint-Based Refactor
- Current Sprint: Sprint 0.5 (Correctness Boundary Definition)
- Status: In Progress

---

# 2. Targets

| Target | Status | Notes |
|--------|--------|------|
| WorkOrderExecution | Sprint 0 mapped | High risk, multi-workflow |
| Transfers | Sprint 0 mapped | Strongest seam, start here |
| QC | Sprint 0 mapped | Workflow mixing |

---

# 3. Sprint 0 Findings

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

# 4. Sprint 0.5 — Correctness Boundary Definition

## Goal
Make correctness explicit before refactoring

### Tasks
- [ ] Identify authoritative writes per workflow
- [ ] Identify projection dependencies
- [ ] Define replay contract per workflow
- [ ] Identify invariant enforcement points
- [ ] Flag cross-transaction risks

### Exit Criteria
- All workflows have explicit:
  - source of truth
  - invariants
  - replay definition

---

# 5. Sprint Plan (Revised)

## Sprint 1 — Transfers Boundary Hardening + Decomposition

### Goal
Make the transfer correctness boundary explicit and non-bypassable, then begin safe decomposition.

### Tasks

#### Boundary Hardening (MUST COME FIRST)
- [ ] Define and enforce single execution path (runInventoryCommand)
- [ ] Identify and restrict unsafe entry points (e.g., direct execution primitives)
- [ ] Make replay verification deterministic (remove conditional paths)
- [ ] Document projection dependency (inventory_balance)

#### Decomposition (AFTER HARDENING)
- [ ] Extract transfer events
- [ ] Extract replay logic
- [ ] Separate orchestration from domain logic

### Exit Criteria
- All transfer mutations go through one enforced path
- Replay is deterministic and consistent
- Projection dependency is explicit and documented
- Orchestration layer is thinner
- No behavioral change

---

## Sprint 2 — QC Separation

### Goal
Separate domain concerns

### Tasks
- [ ] Split QC workflows:
  - receipt
  - work order
  - execution
- [ ] Isolate disposition logic

---

## Sprint 3+ — WorkOrder Decomposition

### Goal
Safely decompose largest monolith

### Preconditions
- Transfers + QC patterns proven
- Correctness boundaries defined

---

# 6. Refactor Rules

- No behavioral changes
- No projection-based correctness
- Replay must remain deterministic
- One workflow per module
- Preserve invariants

---

# 7. Metrics

## Structural
- Workflows isolated
- File size reduction

## Risk
- Replay failures = 0
- Invariant violations = 0

---

# 8. Decisions Log

| Date | Decision | Rationale |
|------|----------|----------|
| 2026-04-09 | Start with Transfers | Lowest risk, strongest boundary |
| 2026-04-09 | Add Sprint 0.5 | Correctness must precede refactor |
| 2026-04-09 | Add boundary hardening to Sprint 1 | Prevent correctness regressions |
