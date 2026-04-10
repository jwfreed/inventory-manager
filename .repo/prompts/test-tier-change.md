# Test Tier Change Prompt Template

Use this template when adding, moving, or modifying tests across the tiered test suite.

---

## Context

Repository: inventory-manager
Change type: test tier modification
Tier affected: [truth | contracts | scenarios]

## Test Tier Rules

- `truth` — invariant-only checks and architecture guards. Must remain strictly invariant-focused.
- `contracts` — representative mutation-family coverage.
- `scenarios` — heavy operational and load workflows.

Do not move a test between tiers without justification.

## Invariant Coverage Requirements

The `truth` tier must retain coverage for:

- Ledger immutability (append-only, no UPDATE/DELETE on ledger tables)
- Schema and migration lint guards
- Idempotency correctness
- Deterministic hash integrity
- Quantity conservation
- Projection rebuild equality

Do not remove or weaken any of the above. The invariant must remain strict.

## Task Description

[Describe the specific test change here]

## Verification Required

- `npm run test:truth` — must pass with no regressions
- `npm run test:contracts` — must pass with no regressions
- `npm run test:scenarios` — must pass with no regressions

Do not add CI commands that are not backed by npm scripts.
