# Debugging Tests Runbook

API and ops tests are run with Node’s built-in test runner. Tests are designed to be deterministic and warehouse-scoped. If a suite hangs or times out, use the handle diagnostics below.

## Standard Commands

API tests:

```bash
npm run test:api
```

Operational (AK-47) suite:

```bash
npm run test:ops
```

DB trigger/invariant suite:

```bash
npm run test:db
```

Full suite (sequential by default):

```bash
npm run test:all
```

## Handle Leak Diagnostics

Enable handle snapshot logging:

```bash
TEST_DEBUG_HANDLES=1 node --test --test-reporter=spec --test-timeout=120000 --test-concurrency=1 --import ./tests/setup.mjs tests/api/*.test.mjs
```

What you’ll see:
- Per-test counts of new handles (e.g., `Socket x2`, `Timeout x1`)
- A final list of active handles/requests after the run

Use this to identify which test introduces a persistent handle and close it in test teardown.

## Event Loop Leaks

Common sources:
- Unclosed `pg.Pool` connections
- Pending HTTP keep-alive sockets
- Untracked `setInterval`

Mitigation:
- Use `ensureSession` and its shared pool; it is closed after all tests.
- Prefer `waitForCondition` instead of manual timers.
- Avoid creating global intervals in test files.

## Polling and Eventual Consistency

Many flows (QC, ATP, backorders) are eventually consistent. Use the shared polling helper:

```js
import { waitForCondition } from '../api/helpers/waitFor.mjs';

await waitForCondition(fetch, predicate, { label: 'ATP converged' });
```

On timeout, errors include label, elapsed time, last value, and last error.

## Test Helpers

Use the shared helpers from `tests/api/helpers/`:
- `ensureSession` (auth + tenant isolation)
- `ensureStandardWarehouse` (Phase 6–correct warehouse graph)
- `waitForCondition` (eventual consistency)

Do not write directly to DB tables in API tests.

## Related Docs

- CI workflow: `docs/runbooks/ci.md`
- Warehouses: `docs/runbooks/warehouses.md`
