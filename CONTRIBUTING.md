# Contributing

## Philosophy

Inventory systems fail quietly. Prefer auditability, deterministic behavior, and explicit invariants over convenience or implicit defaults.

## Test tiers

Tests are organized by intent:

- **API** (`tests/api/`): request/response behavior and simple flows
- **Ops (AK-47)** (`tests/ops/`): long transactional workflows (QC, ATP, reservations)
- **DB** (`tests/db/`): triggers, invariants, and DB-only semantics

Scripts:

```bash
npm run test:api
npm run test:ops
npm run test:db
npm run test:all
```

## Helper usage

Use these helpers instead of bespoke logic:

- `ensureSession` — authenticated session + tenant isolation
- `ensureStandardWarehouse` — Phase 6–correct warehouse graph via template endpoint
- `waitForCondition` — eventual consistency polling
- `apiRequest` — shared request wrapper in each test file

## Rules

- **No direct DB writes in API tests.** Use the standard warehouse template and API endpoints.
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
