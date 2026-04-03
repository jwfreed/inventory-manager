# SKILL: inventory-implementation-planner

## PURPOSE
Turn an inventory task into a tightly scoped implementation plan before coding starts. This skill prevents semantic drift, partial cross-layer updates, and refactors that silently change operational meaning.

## WHEN TO USE
- Use before non-trivial work that may affect inventory semantics, workflow boundaries, schema, services, APIs, UI, reporting, or migrations.
- Use when a task touches receiving, transfer, picking, shipping, adjustment, counting, replenishment, quarantine, or any quantity calculation.
- Use when the requested change spans more than one layer or could be mistaken for a local refactor.
- Use when a new state, new field meaning, or migration is involved.

## INSTRUCTIONS
1. Classify the task before editing:
- domain mutation
- planning logic
- UI workflow
- reporting only
- schema or data migration
- refactor with no intended behavior change
2. List the exact scope:
- touched states
- touched workflows
- touched entities, tables, or models
- touched user roles or system actors
- touched APIs, services, jobs, reports, projections, and UI surfaces
3. Separate intent from mechanics:
- desired operator or system outcome
- underlying workflow or data change required
- behavior that must remain unchanged
4. Decide the coordination surface:
- schema
- service
- API
- UI
- reporting
- migration or backfill
5. If quantity truth is affected, require these checks in the plan:
- invariants at risk
- concurrency scope
- auditability impact
- rollback or partial-failure behavior
6. If the task touches receiving, transfer, picking, shipping, or adjustment, require an end-to-end workflow pass instead of a single-endpoint patch.
7. If the task adds or changes a state, plan updates for:
- domain model
- API and payload semantics
- UI labels and actions
- reporting and derived views
- tests
8. If a migration is involved, define:
- forward mapping
- fallback behavior
- orphan handling
- integrity verification query or equivalent validation
9. Produce the smallest safe execution order that keeps public behavior stable unless an explicit behavior change is part of the task.

## CONSTRAINTS
- Do not start implementation before classification and scoping are written down.
- Do not treat a semantics change as a cosmetic change or a pure refactor.
- Do not assume a workflow can be changed in only one layer when operational truth spans several layers.
- Do not invent repository-specific modules or schema details that are not present.
- Do not reuse an existing field, state, or derived metric for a different meaning.
- Do not absorb review, test, or UI-specific acceptance guidance into this skill beyond what is needed to scope the work.
- Do not widen the task with unrelated cleanup once the safe change set is defined.

## OUTPUT EXPECTATIONS
- Return a bounded plan with task classification, touched states, touched workflows, touched entities, affected layers, and non-goals.
- State the coordination points that must stay aligned across schema, service, API, UI, reporting, and migration boundaries.
- State whether the task changes planning logic, execution logic, reporting logic, or multiple categories.
- State the main risks that must be validated during implementation.
- Keep the plan narrow enough to drive immediate implementation without speculative refactors.

## FAILURE MODES TO PREVENT
- A small UI or API change silently changes inventory semantics.
- A service refactor bypasses transaction logging or approved write boundaries.
- A new endpoint writes balances directly instead of using movement services.
- A migration reinterprets historical stock by changing defaults or field meaning.
- A derived availability field becomes the system-of-record quantity.
- A partial implementation updates one path while alternate paths remain inconsistent.
- A workflow is simplified around assumptions such as one warehouse, one UOM, or full receipts only.
