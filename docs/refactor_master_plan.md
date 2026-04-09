# Refactoring Master Plan — Inventory Manager

## Purpose
Provide a **single source of truth** for refactoring progress, decisions, and next steps.  
This document is designed to be shared across chats and updated incrementally.

---

# 1. Current Status Dashboard

## Overall Progress
- Phase: Sprint-Based Refactor
- Current Sprint: Sprint 0
- Status: In Progress

## Targets
| Target | Status | Notes |
|--------|--------|------|
| WorkOrderExecution | Not Started | Highest priority |
| Transfers | Not Started | |
| QC | Not Started | |

---

# 2. Sprint Plan

## Sprint 0 — Safety + Mapping
**Goal:** Establish safety and understanding

### Tasks
- [ ] Add/verify architecture tests
- [ ] Create boundary maps for target files
- [ ] Define “done” criteria

### Deliverables
- Boundary maps completed
- Test coverage verified

---

## Sprint 1 — WorkOrder: Scrap + Void
**Goal:** Extract first workflows safely

### Tasks
- [ ] Extract Scrap workflow
- [ ] Extract Void workflow
- [ ] Add targeted tests

### Exit Criteria
- Workflows isolated
- No behavior change
- Tests pass

---

## Sprint 2 — WorkOrder: Issue + Completion
**Goal:** Extract core mutation workflows

### Tasks
- [ ] Extract Issue workflow
- [ ] Extract Completion workflow

---

## Sprint 3 — WorkOrder: Batch + Shared Modules
**Goal:** Remove monolith

### Tasks
- [ ] Extract Batch/Reporting
- [ ] Create shared modules:
  - Replay
  - WIP
  - Projection

---

## Sprint 4 — Transfers Refactor
**Goal:** Thin orchestration

### Tasks
- [ ] Extract request layer
- [ ] Extract events
- [ ] Extract replay
- [ ] Extract reversal logic

---

## Sprint 5 — QC Refactor
**Goal:** Separate decision vs movement

### Tasks
- [ ] Extract QC policy
- [ ] Extract QC event logic
- [ ] Extract QC disposition

---

## Sprint 6 — Consolidation
**Goal:** Cleanup + clarity

### Tasks
- [ ] Remove dead code
- [ ] Improve naming
- [ ] Add module docs

---

# 3. Work Tracking

## Active Work
| Task | Owner | Status | Notes |
|------|------|--------|------|
|  |  |  |  |

## Completed Work
| Task | Completed Date | Notes |
|------|----------------|------|
|  |  |  |

---

# 4. Refactor Rules (Non-Negotiable)

- No behavioral changes
- Preserve authoritative state
- Replay must remain deterministic
- One workflow per module
- No shallow modules (helpers/utils dumps)

---

# 5. Task Template

Use this for each refactor:

---
**Title:**  
**Workflow:**  

**Invariants:**  
-  

**Definition of Done:**  
-  
-  

**Risks:**  
-  

**Validation:**  
-  
---

---

# 6. Metrics

## Structural
- Workflows extracted:
- Files reduced:

## Risk
- Replay failures: 0
- Invariant violations: 0

## Cognitive
- Can a new dev understand module in <10 min?

---

# 7. Next Actions

- Define boundary map for WorkOrderExecution
- Start Sprint 1 after validation

---

# 8. Notes / Decisions Log

| Date | Decision | Rationale |
|------|----------|----------|
|  |  |  |
