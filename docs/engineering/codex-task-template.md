# Codex Task Template

Use this template for future inventory work so Codex enters the repository with the correct operating rules already in scope.

## Required Inputs

- Objective: `<what needs to change>`
- Affected area: `<workflow, screen, API, service, report, migration, or doc>`
- Known constraints: `<domain, operational, delivery, or compatibility limits>`
- Expected verification: `<tests, review depth, or workflow proof required>`

## Mandatory Instructions

1. Read `AGENTS.md` before doing non-trivial work.
2. Inspect `.skills/` and identify every repo-local skill relevant to the task.
3. Execute all relevant repo-local skills together; do not pick only one if several apply.
4. Complete each skill's OUTPUT SCHEMA before implementation.
5. Keep the implementation tightly scoped to the requested behavior.
6. Preserve inventory invariants, explicit state semantics, movement auditability, and UI truthfulness.
7. Avoid unrelated refactors, speculative cleanup, or behavior changes outside the declared scope.
8. Add or update tests appropriate to the affected workflow and failure modes.

## Required Skill Output

Before implementation, return:

- Outputs from each relevant skill
- Each must follow the skill's OUTPUT SCHEMA

Do not proceed if any schema is incomplete.

## Execution Checklist

1. Classify the task type.
2. Execute all relevant skills and complete their schemas.
3. List the touched states, workflows, entities, and layers.
4. Name the invariants and failure modes at risk.
5. Implement only the smallest safe change set.
6. Add or update targeted tests and verification.
7. Self-review the result against the relevant repo-local skills.

## Reusable Prompt

```text
Read AGENTS.md first. Then inspect .skills/ and apply every repo-local skill relevant to this task.

Before implementation, return the completed OUTPUT SCHEMA from each relevant skill. Do not proceed if any schema is incomplete.

Task:
<describe the requested change>

Scope constraints:
<describe what must not change>

Verification expectations:
<describe tests, workflow proofs, or review depth required>

Implementation requirements:
- keep the change tightly scoped
- preserve inventory state semantics and auditability
- avoid unrelated refactors or speculative cleanup
- update tests only where needed to prove workflow integrity and failure handling

Deliver:
- the completed skill outputs
- the implementation
- the relevant tests
- a concise summary of what changed, what was verified, and any remaining risk
```
