# inventory-manager

## Phase 0 — Features 1 & 2 Migrations

This repository now includes a minimal Node.js/TypeScript migration setup powered by `node-pg-migrate`. The migrations currently implement:

- Phase 0 Feature 1: `items`, `locations`, `inventory_movements`, `inventory_movement_lines`
- Phase 0 Feature 2: `locations` hierarchy fields and the `audit_log` table
- Phase 1 Feature 1: `vendors`, `purchase_orders`, `purchase_order_lines` (run after Phase 0)

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

1. `psql "$DATABASE_URL" -c "\\dt"` — tables should list `items`, `locations`, `inventory_movements`, `inventory_movement_lines`, and `audit_log`.
2. `psql "$DATABASE_URL" -c "\\d+ locations"` — check the `chk_locations_type` constraint, verify indexes on `type` and `active`, and ensure the hierarchy fields exist with `idx_locations_parent` plus the `chk_locations_parent_not_self` constraint.
3. `psql "$DATABASE_URL" -c "\\d+ inventory_movement_lines"` — verify the `movement_id` foreign key shows `ON DELETE CASCADE` and the `chk_movement_lines_qty_nonzero` constraint enforces `quantity_delta <> 0`.
4. `psql "$DATABASE_URL" -c "\\d+ audit_log"` — confirm all documented columns, the indexes on `occurred_at`, `(entity_type, entity_id, occurred_at)`, `(actor_type, actor_id, occurred_at)`, `request_id`, and the `actor_type`/`action` check constraints.

If any of these checks fail, re-run migrations after dropping the schema or inspect the individual migration files in `src/migrations`.

## Phase 1 — Feature 1 API (Vendors + Purchase Orders)

### Starting the API

1. Ensure dependencies are installed (`npm install`) and migrations are applied.
2. Set the same `DATABASE_URL` you use for migrations.
3. Start the API:

```bash
npm run dev
```

The Express server listens on `PORT` (default `3000`).

### Manual smoke test

Run these commands in a separate terminal (adjust IDs as needed):

```bash
# 1) Create a vendor
curl -s -X POST http://localhost:3000/vendors \
  -H 'Content-Type: application/json' \
  -d '{"code":"VEND-001","name":"Acme Cacao","email":"buying@acme.test","phone":"+1-555-1234"}' | jq .

# 2) Create a purchase order with two lines
curl -s -X POST http://localhost:3000/purchase-orders \
  -H 'Content-Type: application/json' \
  -d '{
    "poNumber": "PO-1001",
    "vendorId": "<REPLACE_WITH_VENDOR_ID>",
    "status": "draft",
    "orderDate": "2024-01-05",
    "expectedDate": "2024-01-12",
    "lines": [
      {"itemId": "<ITEM_UUID>", "uom": "kg", "quantityOrdered": 100},
      {"itemId": "<ITEM_UUID>", "uom": "kg", "quantityOrdered": 50}
    ]
  }' | jq .

# 3) Fetch the purchase order (replace with ID returned in step 2)
curl -s http://localhost:3000/purchase-orders/<PO_ID> | jq .

# 4) List purchase orders
curl -s 'http://localhost:3000/purchase-orders?limit=10&offset=0' | jq .
```

Successful responses confirm the API can create/list vendors and purchase orders with line items.
