# inventory-manager

## Phase 0 — Features 1 & 2 Migrations

This repository now includes a minimal Node.js/TypeScript migration setup powered by `node-pg-migrate`. The migrations currently implement:

- Phase 0 Feature 1: `items`, `locations`, `inventory_movements`, `inventory_movement_lines`
- Phase 0 Feature 2: `locations` hierarchy fields and the `audit_log` table
- Phase 1 Feature 1: `vendors`, `purchase_orders`, `purchase_order_lines`
- Phase 1 Feature 2: `purchase_order_receipts`, `purchase_order_receipt_lines`, `qc_events`, `qc_inventory_links`
- Phase 1 Feature 3: `putaways`, `putaway_lines`

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

## Phase 1 — Features 1 & 2 API (Vendors, Purchase Orders, Receiving, QC)

### Starting the API

1. Ensure dependencies are installed (`npm install`) and all migrations have been applied (`npm run migrate`).
2. Set the same `DATABASE_URL` used for migrations.
3. Start the API (default port `3000`):

```bash
npm run dev
```

### Available endpoints

- `POST /vendors`, `GET /vendors`
- `POST /purchase-orders`, `GET /purchase-orders`, `GET /purchase-orders/:id`
- `POST /purchase-order-receipts`, `GET /purchase-order-receipts/:id`
- `POST /qc-events`, `GET /purchase-order-receipt-lines/:id/qc-events`
- `POST /putaways`, `GET /putaways/:id`, `POST /putaways/:id/post`

### Manual smoke test

The steps below exercise Vendors → POs → Receipts → QC → Putaway. Replace placeholder UUIDs with the real ones returned from earlier steps.

```bash
# 0) Insert a test item and two locations directly (use `uuidgen` for UUIDs).
psql "$DATABASE_URL" -c "INSERT INTO items (id, sku, name, active, created_at, updated_at) VALUES ('<ITEM_UUID>', 'COCOA-001', 'Cocoa Nibs', true, now(), now());"
psql "$DATABASE_URL" -c "INSERT INTO locations (id, code, name, type, active, created_at, updated_at) VALUES ('<STAGING_LOCATION_UUID>', 'STAGE-001', 'Receiving Staging', 'virtual', true, now(), now());"
psql "$DATABASE_URL" -c "INSERT INTO locations (id, code, name, type, active, created_at, updated_at) VALUES ('<BIN_LOCATION_UUID>', 'BIN-A1', 'Finished Bin A1', 'bin', true, now(), now());"

# 1) Create a vendor
curl -s -X POST http://localhost:3000/vendors \
  -H 'Content-Type: application/json' \
  -d '{"code":"VEND-001","name":"Acme Cacao","email":"buying@acme.test","phone":"+1-555-1234"}' | jq .

# 2) Create a purchase order with two lines (save the returned PO + line IDs)
curl -s -X POST http://localhost:3000/purchase-orders \
  -H 'Content-Type: application/json' \
  -d '{
    "poNumber": "PO-1001",
    "vendorId": "<VENDOR_ID>",
    "orderDate": "2024-01-05",
    "expectedDate": "2024-01-12",
    "lines": [
      {"itemId": "<ITEM_UUID>", "uom": "kg", "quantityOrdered": 100},
      {"itemId": "<ITEM_UUID>", "uom": "kg", "quantityOrdered": 50}
    ]
  }' | jq .

# 3) Fetch the PO to copy its line IDs
curl -s http://localhost:3000/purchase-orders/<PO_ID> | jq '.lines'

# 4) Create a purchase order receipt for those lines (send to the staging location)
curl -s -X POST http://localhost:3000/purchase-order-receipts \
  -H 'Content-Type: application/json' \
  -d '{
    "purchaseOrderId": "<PO_ID>",
    "receivedAt": "2024-01-15T15:00:00Z",
    "receivedToLocationId": "<STAGING_LOCATION_UUID>",
    "lines": [
      {"purchaseOrderLineId": "<PO_LINE_1_ID>", "uom": "kg", "quantityReceived": 90},
      {"purchaseOrderLineId": "<PO_LINE_2_ID>", "uom": "kg", "quantityReceived": 40}
    ]
  }' | jq .

# 5) Add QC events against the first receipt line
curl -s -X POST http://localhost:3000/qc-events \
  -H 'Content-Type: application/json' \
  -d '{
    "purchaseOrderReceiptLineId": "<RECEIPT_LINE_ID>",
    "eventType": "hold",
    "quantity": 10,
    "uom": "kg",
    "actorType": "user",
    "reasonCode": "QC-HOLD",
    "notes": "Visual inspection"
  }' | jq .

curl -s -X POST http://localhost:3000/qc-events \
  -H 'Content-Type: application/json' \
  -d '{
    "purchaseOrderReceiptLineId": "<RECEIPT_LINE_ID>",
    "eventType": "accept",
    "quantity": 50,
    "uom": "kg",
    "actorType": "user",
    "notes": "Released for putaway"
  }' | jq .

# 6) Fetch the receipt to view QC summaries per line
curl -s http://localhost:3000/purchase-order-receipts/<RECEIPT_ID> | jq '.lines'

# 7) List QC events for the line
curl -s http://localhost:3000/purchase-order-receipt-lines/<RECEIPT_LINE_ID>/qc-events | jq .

# 8) Create a putaway for the accepted quantity
curl -s -X POST http://localhost:3000/putaways \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceType": "purchase_order_receipt",
    "purchaseOrderReceiptId": "<RECEIPT_ID>",
    "lines": [
      {
        "purchaseOrderReceiptLineId": "<RECEIPT_LINE_ID>",
        "toLocationId": "<BIN_LOCATION_UUID>",
        "uom": "kg",
        "quantity": 40
      }
    ]
  }' | jq .

# 9) Post the putaway (moves inventory from staging to the bin)
curl -s -X POST http://localhost:3000/putaways/<PUTAWAY_ID>/post | jq .

# 10) Verify inventory movements show the transfer
psql "$DATABASE_URL" -c "
SELECT item_id, location_id, uom, SUM(quantity_delta) AS on_hand
FROM inventory_movement_lines
GROUP BY item_id, location_id, uom
ORDER BY location_id;
"
```

Successful responses confirm vendors/POs work end-to-end, receipts insert atomically, QC events enforce the service validations, putaway posting creates balanced transfer movements, and the `inventory_movement_lines` ledger reflects the move from staging to the storage bin.
