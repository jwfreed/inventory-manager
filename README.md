# inventory-manager

## Phase 0 — Feature 1 Migrations

This repository now includes a minimal Node.js/TypeScript migration setup powered by `node-pg-migrate`. The initial migrations implement the four foundational tables for Phase 0 Feature 1: `items`, `locations`, `inventory_movements`, and `inventory_movement_lines`.

### Prerequisites

- Node.js 18+
- PostgreSQL instance you can connect to
- `DATABASE_URL` environment variable pointing at the target database (e.g., `postgres://user:pass@localhost:5432/inventory_manager`)

Install dependencies once:

```bash
npm install
```

### Running migrations

Apply all pending migrations:

```bash
npm run migrate
```

Roll back the latest batch if needed:

```bash
npm run migrate:down
```

### Smoke test / manual verification

After running the migrations on an empty database, confirm the schema with `psql` (or any SQL client):

1. `psql "$DATABASE_URL" -c "\\dt"` — tables should list `items`, `locations`, `inventory_movements`, `inventory_movement_lines`.
2. `psql "$DATABASE_URL" -c "\\d+ locations"` — check the `chk_locations_type` constraint enforces the allowed type values and indexes exist on `type` and `active`.
3. `psql "$DATABASE_URL" -c "\\d+ inventory_movement_lines"` — verify the `movement_id` foreign key shows `ON DELETE CASCADE` and the `chk_movement_lines_qty_nonzero` constraint enforces `quantity_delta <> 0`.

If any of these checks fail, re-run migrations after dropping the schema or inspect the individual migration files in `src/migrations`.
