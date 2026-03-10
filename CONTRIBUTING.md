# Contributing

## Philosophy

Inventory systems fail quietly. Prefer auditability, deterministic behavior, and explicit invariants over convenience or implicit defaults.

## Test tiers

Tests are organized into repository-level tiers with manifests under `tests/truth/`, `tests/contracts/`, and `tests/scenarios/`.

- **Truth**: invariant-only guards and ledger correctness checks
- **Contracts**: representative mutation-family tests
- **Scenarios**: heavy operational and load workflows

Scripts:

```bash
npm run test:truth
npm run test:contracts
npm run test:scenarios
npm run e2e
```

## Helper usage

Use these helpers instead of bespoke logic:

- `ensureSession` — authenticated session + tenant isolation
- `ensureStandardWarehouse` — Phase 6–correct warehouse graph via template endpoint
- `waitForCondition` — eventual consistency polling
- `apiRequest` — shared request wrapper in each test file

## Rules

- **No direct DB writes in API tests.** Use the standard warehouse template and API endpoints.
- **Do not weaken truth tests.** If a correctness invariant changes, update the docs, tier manifest, and guard tests in the same change.
- **Warehouse roots are role-less and non-sellable.** Do not set roles on roots in tests.
- **Role bins are discovered by role, not code.** Codes are globally unique.
- **Scope all locations to a warehouse.** Never assume global `/locations` results.
- **Use waitForCondition** for eventual consistency (QC accept, ATP/backorders, dedupe).

## Test authoring checklist

- [ ] Uses `ensureSession` and `ensureStandardWarehouse`
- [ ] Uses warehouse-scoped locations and defaults
- [ ] Uses `waitForCondition` for eventual consistency
- [ ] Avoids direct DB writes (unless in DB tier)
- [ ] Avoids hardcoded location codes

## Debugging

Enable handle diagnostics when tests hang:

```bash
TEST_DEBUG_HANDLES=1 node --test --test-reporter=spec --test-timeout=120000 --test-concurrency=1 --import ./tests/setup.mjs tests/api/*.test.mjs
```

See `docs/runbooks/debugging_tests.md` for more.
