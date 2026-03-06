# Playwright E2E

This suite validates core inventory workflows with a hybrid UI + API approach.

## Required Environment Variables

- `DATABASE_URL` (required for DB customer helper)
- `JWT_SECRET` (required by API server)
- Auth credentials (one pair required, no defaults):
  - `E2E_USER` + `E2E_PASS` (preferred)
  - or `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` (fallback)
- Optional:
  - `E2E_BASE_URL` (default: `http://127.0.0.1:4173`)
  - `E2E_API_BASE_URL` (default: `http://127.0.0.1:3000`)
  - `E2E_TENANT_SLUG`
  - `E2E_TENANT_NAME`
  - `E2E_DB_CLEANUP=true` to enable best-effort customer cleanup

## Local Run

1. Install dependencies:

```bash
npm ci
npm ci --prefix ui
npm run e2e:install
```

2. Prepare backend:

```bash
npm run migrate:up
npm run dev -- --repair-defaults
```

3. Build and serve UI preview (production-like):

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000 npm --prefix ui run build
npm --prefix ui run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

4. Generate auth state once:

```bash
npm run e2e:setup
```

5. Run E2E suite:

```bash
npm run e2e
```

## Run A Single Test

```bash
npx playwright test tests/e2e/workflows/outbound-fulfillment.spec.ts -g "cancel allocated reservation"
```

## Test Tags

- `@smoke`: fast confidence checks
- `@core`: core inventory workflow correctness checks

Run by tag:

```bash
npx playwright test --grep @smoke
npx playwright test --grep @core
```

## Regenerate Auth State

Delete `playwright/.auth/user.json` and `playwright/.auth/meta.json`, then run:

```bash
npm run e2e:setup
```

## Reports and Traces

- Open HTML report:

```bash
npm run e2e:report
```

- Traces/videos/screenshots are stored under `test-results/` and retained on failure by config.

## Seeding and Security

- Inventory fixtures are API-first (`/locations`, `/items`, `/vendors`, `/purchase-orders`, `/purchase-order-receipts`, `/qc-events`, `/putaways`, `/sales-orders`, `/reservations`, `/shipments`, `/inventory-transfers`).
- No new production seed endpoint is added.
- DB is used only for deterministic test-customer creation (`customers`) because no customer create API exists.
- Customer cleanup is optional (`E2E_DB_CLEANUP=true`) and dependency-safe (deletes only unreferenced rows).

## CI Scope Selection

The Playwright GitHub workflow runs the full suite by default.  
For manual `workflow_dispatch`, you can choose:

- `scope=all` (default): runs all tests
- `scope=smoke`: runs only tests tagged `@smoke`
