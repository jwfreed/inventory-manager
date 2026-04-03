# SKILL: inventory-implementation-planner

## PURPOSE
Classify the task and define the smallest safe implementation scope before coding begins.

## WHEN TO USE
- Use before non-trivial work that may affect inventory workflows, schema, services, APIs, UI, reporting, or migrations.
- Use when a task spans more than one layer or may be mistaken for a local refactor.
- Use when a request introduces a new state, field meaning, workflow step, or migration.

## INSTRUCTIONS
1. Classify the task as one primary type:
- domain mutation
- planning logic
- UI workflow
- reporting only
- schema or data migration
- refactor with no intended behavior change
2. List the touched states.
3. List the touched workflows.
4. List the touched entities, tables, or models.
5. List the affected layers:
- schema
- service
- API
- UI
- reporting
- migration
6. State the non-goals that must remain out of scope.
7. State up to three implementation risks.

## CONSTRAINTS
- Do not include deep validation, review decisions, or test design in this skill.
- Do not widen the task with unrelated cleanup.
- Do not treat a semantic change as a cosmetic refactor.
- Do not invent repository-specific modules or schema details that are not present.
- Do not proceed to implementation until scope and non-goals are explicit.

## OUTPUT EXPECTATIONS
- Produce one bounded planning output that can be used directly to scope implementation.
- Keep the output limited to classification, touched scope, affected layers, non-goals, and capped risks.
- Keep the result concise enough that later review and test skills can build on it without reinterpretation.

## FAILURE MODES TO PREVENT
- Scope creep into unrelated cleanup.
- Partial implementation that misses an affected layer.
- Semantic changes hidden inside refactors.
- Migration or reporting work started without explicit scope boundaries.
- Planner output that blends into review or test strategy.

## OUTPUT SCHEMA (REQUIRED)
- Task type:
- Touched states:
- Touched workflows:
- Touched entities:
- Affected layers:
- Non-goals:
- Risks (max 3):

## EXECUTION RULE
Do not proceed until the OUTPUT SCHEMA is fully completed.
Incomplete outputs are invalid.
