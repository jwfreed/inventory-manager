# CI Runbook

This repository uses GitHub Actions with Postgres-backed API integration tests. CI is tiered to keep merge latency low while preserving invariant coverage.

## CI Flow (GitHub Actions)

High-level steps:
1. Start Postgres and Redis
2. Run migrations
3. Start API server
4. Wait for `/healthz`
5. Run the tier script that matches the trigger

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

- name: Truth tests
  if: github.event_name == 'pull_request'
  run: npm run test:truth

- name: Contract tests
  if: github.event_name == 'push'
  run: npm run test:contracts
```

## Local CI-equivalent run

```bash
export DATABASE_URL="postgres://$USER@localhost:5432/inventory_dev"
export TEST_DATABASE_URL="$DATABASE_URL"
npm run migrate:up
npm run dev
npm run test:api
```

## Postgres provisioning (local)

- Ensure a local Postgres instance is running
- Create a dev/test database (e.g., `inventory_dev`)
- Point `DATABASE_URL` at that database before running migrations/tests
- For spawned API processes in tests, `TEST_DATABASE_URL` overrides `DATABASE_URL` and is recommended in CI.

## Test Order and Suites

- **PR merge gate**: `npm run test:truth`
- **Push validation**: `npm run test:contracts`
- **Nightly heavy workflows**: `npm run test:scenarios`
- **UI E2E**: `npm run e2e` (manual/on-demand workflow)

Suggested order for local verification:

1. `npm run test:truth`
2. `npm run test:contracts`
3. `npm run test:scenarios`
4. `npm run e2e`

## Debug Flags

- `TEST_DEBUG_HANDLES=1` — log event-loop handles after each test
- `TEST_AFTER_EACH_DELAY_MS=0` — disable post-test delay

## Related Docs

- Debugging tests: `docs/engineering/runbooks/debugging_tests.md`
- Warehouses: `docs/engineering/runbooks/warehouses.md`
- Invariants: `docs/engineering/runbooks/invariants.md`
