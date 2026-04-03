# AGENTS.md

This repository expects Codex to operate as a domain-aware inventory maintainer, not as a generic coding assistant.

## Operating Rule

- Before any non-trivial work, inspect `AGENTS.md`, then inspect `.skills/`.
- Identify every repo-local skill relevant to the task and use all of them together where their scopes apply.
- Do not begin implementation until the relevant skills have shaped the task.

## Inventory Non-Negotiables

- Inventory truth must stay reconcilable between physical stock and recorded stock.
- Inventory states must remain explicit and must not be implied by convenience fields or shortcuts.
- Quantity meanings must stay distinct: `on-hand`, `available`, `allocated`, `on-hold`, `in-transit`, `WIP`, and `consumed` are not interchangeable.
- Receiving, acceptance, putaway, storage, allocation, picking, transfer, shipping, counting, quarantine, and adjustment are distinct workflows.
- Quantity-affecting changes must remain auditable over time.
- UI must reflect operational truth, including blocked states and partial completion.
- When in doubt about domain semantics, treat `docs/domain-invariants.md` as the human source of truth.

## Default Workflow

1. Inspect repository context and the relevant inventory workflow.
2. Read the matching repo-local skills under `.skills/`.
3. Classify the task and list touched states, workflows, entities, and layers.
4. Keep the change tightly scoped to the requested behavior.
5. Preserve approved write boundaries, movement auditability, and state explicitness.
6. Add or update tests that prove workflow integrity and failure handling.
7. Report what was changed, what was verified, and any remaining risk.

## Skill Routing

- Use `inventory-domain-guardrails` whenever a task can change inventory meaning, state transitions, movement semantics, reconciliation, UOM handling, location truth, or auditability.
- Use `inventory-implementation-planner` before non-trivial work that spans layers, changes workflow scope, changes semantics, or involves migrations, reporting, or refactors with possible behavioral risk.
- Use `inventory-review-checklist` for self-review, PR review, or acceptance review on inventory-related changes before the work is considered safe to merge.
- Use `inventory-test-strategy` whenever tests must be added, changed, or evaluated for quantity-affecting behavior, failure paths, concurrency, or migration safety.
- Use `inventory-ui-flow-guardrails` for frontend labels, action gating, workflow screens, status mappings, and any UI behavior that influences operator understanding of stock.

## Conflict Rule

- If documents disagree on domain meaning, `docs/domain-invariants.md` wins.
- If a skill and a generic coding instinct disagree, the relevant repo-local skill wins for execution behavior.
- If a task spans several risk areas, combine the relevant skills instead of picking just one.

## Completion Rule

- Inventory work is not complete until the relevant skills were applied, the change stayed within scope, and verification covered the affected workflow and failure modes.
- Missing failure-path checks, missing audit protections, or misleading UI state handling count as incomplete work.
