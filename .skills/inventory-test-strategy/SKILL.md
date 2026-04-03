# SKILL: inventory-test-strategy

## PURPOSE
Define the tests required to prove inventory behavior stays correct under normal operation, retries, partial failures, and concurrent mutations.

## WHEN TO USE
- Use when adding or changing inventory mutations, workflow states, quantity calculations, reconciliation logic, migrations, or UI action gating tied to inventory truth.
- Use when a task affects receiving, storage, allocation, picking, transfer, shipping, counting, adjustment, replenishment, or audit behavior.
- Use when existing tests do not clearly prove state integrity and failure handling.

## INSTRUCTIONS
1. Classify the change by workflow and test layers needed:
- unit
- service
- integration
- workflow
- concurrency
- migration
- UI
2. Enumerate the states and transitions that must be proven.
3. For each quantity mutation, add or update tests for:
- happy path
- insufficient stock or invalid source state
- duplicate request or replay
- partial failure
- concurrent attempt
- invalid state transition
4. For receiving, separate tests for:
- planned
- physically received
- accepted
- put away
5. For transfer, separate tests for:
- source decrement
- in-transit state
- destination receipt
- partial receipt
- cancellation or recovery behavior
6. For picking and shipping, separate tests for:
- reservation or allocation
- pick release or staging
- shipment finalization
- reversal or corrective action behavior
7. For counting and adjustment, test:
- discrepancy detection
- approval path
- reason code capture
- audit trail
- restored or adjusted availability
8. For UOM, test valid conversions, invalid conversions, and rounding boundaries.
9. For multi-location truth, test local availability separately from network inventory.
10. Name scenarios by operational behavior, and require at least one end-to-end test for each new workflow or new state.

## CONSTRAINTS
- Do not rely on status-code assertions without checking quantity outcomes and resulting state.
- Do not treat render-only UI tests as sufficient when action gating or labels affect operational decisions.
- Do not skip duplicate, retry, partial-failure, or concurrency coverage for quantity-affecting changes.
- Do not mix planning-logic tests with physical execution tests without distinguishing the assertions.
- Do not assume one warehouse, one UOM, one lot, or full receipts unless the repository explicitly constrains it.
- Do not leave migration changes untested when historical stock meaning could change.

## OUTPUT EXPECTATIONS
- Produce a concise test plan grouped by layer and scenario.
- For each proposed test, state the operational behavior under test and the failure mode it covers.
- Include explicit quantity and state assertions, not just API success assertions.
- Include audit, replay, idempotency, or concurrency checks wherever the workflow can corrupt truth over time.
- Keep the scope tight enough that implementation can add the tests directly.

## FAILURE MODES TO PREVENT
- Tests validate response shape but not resulting inventory truth.
- Duplicate submissions or retries are untested.
- Partial receipts, partial transfers, or partial picks are untested.
- Quarantined, blocked, or in-transit stock is accidentally counted as available.
- Adjustment tests ignore reason codes, discrepancy history, or audit trails.
- Location moves fail to prove depletion of the old location and increment of the new one.
- New workflows ship with happy-path coverage only.
