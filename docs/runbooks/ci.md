# CI Runbook

This repository uses GitHub Actions with Postgres and API integration tests. CI is designed to be deterministic and warehouse-safe.

## CI Flow (GitHub Actions)

High-level steps:
1. Start Postgres service
2. Run migrations
3. Start API server
4. Wait for `/healthz`
5. Run tests sequentially

Example snippet:

```yaml
- name: Migrate
  run: npm run migrate:up
  env:
    DATABASE_URL: ${{ env.DATABASE_URL }}

- name: Start server
  run: |
    nohup npm run dev > server.log 2>&1 &
    echo $! > server.pid

- name: Wait for healthz
  run: |
    for i in {1..60}; do
      if curl -fsS "http://localhost:3000/healthz" > /dev/null; then
        echo "Server is ready"; exit 0; fi
      sleep 1
    done
    echo "Server failed to become ready"; cat server.log || true; exit 1

- name: API tests
  run: npm run test:api
```

## Local CI-equivalent run

```bash
export DATABASE_URL="postgres://$USER@localhost:5432/inventory_dev"
npm run migrate:up
npm run dev
npm run test:api
```

## Postgres provisioning (local)

- Ensure a local Postgres instance is running
- Create a dev/test database (e.g., `inventory_dev`)
- Point `DATABASE_URL` at that database before running migrations/tests

## Test Order and Suites

- **API**: `npm run test:api`
- **Ops (AK-47)**: `npm run test:ops`
- **DB/Invariant**: `npm run test:db`
- **All**: `npm run test:all`

Suggested order for local verification:

1. `npm run test:api` (short, API behavior)
2. `npm run test:db` (invariants/triggers)
3. `npm run test:ops` (AK-47 operational flows)
4. `npm run test:all` (full suite)

## Debug Flags

- `TEST_DEBUG_HANDLES=1` — log event-loop handles after each test
- `TEST_AFTER_EACH_DELAY_MS=0` — disable post-test delay

## Related Docs

- Debugging tests: `docs/runbooks/debugging_tests.md`
- Warehouses: `docs/runbooks/warehouses.md`
- Invariants: `docs/runbooks/invariants.md`
