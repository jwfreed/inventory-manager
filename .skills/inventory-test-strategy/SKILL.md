# SKILL: inventory-test-strategy

## PURPOSE
Define the minimum test coverage required to prove inventory behavior remains correct.

## WHEN TO USE
- Use when a task changes quantity-affecting behavior, state transitions, reconciliation logic, migrations, or UI action gating tied to inventory truth.
- Use when receiving, transfer, picking, shipping, counting, adjustment, replenishment, or discrepancy handling changes.
- Use when existing coverage does not clearly prove workflow integrity and failure handling.

## INSTRUCTIONS
1. Name the workflow under change.
2. Select the test layers required:
- unit
- service
- integration
- workflow
- concurrency
- migration
- UI
3. List the scenarios required to prove the workflow is safe.
4. For each scenario, state what it proves and which failure mode it covers.
5. List any missing tests that must be added before the task is complete.

## CONSTRAINTS
- Do not redefine task scope or review merge safety in this skill.
- Do not rely on status-code-only assertions.
- Do not omit failure-path, duplicate, retry, or concurrency coverage where the workflow can corrupt quantity truth.
- Do not mix planning instructions into the test output.
- Do not treat render-only UI checks as sufficient when operator gating matters.

## OUTPUT EXPECTATIONS
- Return a deterministic test plan organized by workflow, layers, scenarios, and missing tests.
- Keep the output limited to required coverage, not implementation planning or review decisions.
- Make each scenario explicit enough to translate directly into a test case.

## FAILURE MODES TO PREVENT
- Happy-path-only coverage.
- Missing duplicate, retry, partial-failure, or race-condition tests.
- Missing quantity or state assertions.
- Missing audit, discrepancy, or reversal coverage where applicable.
- Test output that overlaps with planning or review decisions.

## OUTPUT SCHEMA (REQUIRED)
- Workflow:
- Test layers:
- Scenarios:
  - [name]: [what it proves] -> [failure mode]
- Missing tests:

## EXECUTION RULE
Do not proceed until the OUTPUT SCHEMA is fully completed.
Incomplete outputs are invalid.
