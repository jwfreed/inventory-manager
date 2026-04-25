# Testing Architecture

The repository now runs inventory tests in three tiers.

`tests/truth/`
- Merge gate.
- Target size: 10 to 18 fast tests.
- Purpose: detect ledger corruption, projection drift, quantity drift, valuation drift, idempotency failures, and concurrency ordering regressions with minimal fixtures.
- Command: `npm run test:truth`

`tests/contracts/`
- CI gate outside the merge path.
- Purpose: one user-visible mutation contract per mutation family.
- Command: `npm run test:contracts`

`tests/scenarios/`
- Nightly-only coverage.
- Purpose: high-volume and cross-service flows that are too expensive for the merge path.
- Command: `npm run test:scenarios`

`npm run test:full`
- Runs `truth`, then `contracts`, then `scenarios`.

## Truth Suite Philosophy

The truth suite is the primary corruption net.

Each truth test must do at least one of these things:
- prove ledger replay can reconstruct truth from authoritative movement rows
- prove projections can be rebuilt from the ledger
- prove quantity and valuation remain conserved
- prove retries stay idempotent
- prove concurrent mutations serialize without corrupting stock
- prove append-only and deterministic-hash guarantees fail closed

Truth tests should prefer:
- service-harness setup
- one tenant per test
- one or two mutations per fixture
- direct corruption only against derived projections or explicit corruption fixtures

Truth tests should avoid:
- broad API flows
- large multi-document scenarios
- assertions on helper internals
- slow bootstrap-heavy fixtures

## Contract Suite Rules

The contract suite keeps exactly one file per mutation family:
- `receive`
- `transfer`
- `count`
- `adjustment`
- `shipment`
- `license plate move`
- `work order issue`
- `work order completion`
- `work order reversal`

Each contract test must assert:
- authoritative ledger rows were written
- `inventory.movement.posted` was emitted
- derived balances reflect the mutation
- replay and registry validation stay clean

Contract tests should assert system behavior, not helper implementation details.

## Scenario Suite Rules

Scenario tests are reserved for:
- long end-to-end warehouse flows
- high-volume receipt or transfer sequences
- concurrency races spanning several subsystems
- nightly replay and resilience exercises

Scenario tests may use the API server and larger fixtures. They are intentionally excluded from the PR merge gate.

## Adding A New Test

1. Put corruption or replay safety checks in `tests/truth/` if the test is fast and invariant-oriented.
2. Put one mutation-family behavior check in `tests/contracts/` if the test verifies a user-facing mutation contract.
3. Put broad, slow, or high-volume flows in `tests/scenarios/`.
4. Do not add new merge-gate coverage under `tests/ops/`, `tests/api/`, or `tests/db/`.
5. Reuse `tests/helpers/service-harness.mjs` for service-layer setup before introducing new bespoke fixtures.

## Legacy Layout

Legacy files under `tests/ops/`, `tests/api/`, `tests/db/`, and `tests/architecture/` remain as migration inventory. The active runner and CI gates now execute only the tiered directories above.
