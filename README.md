# inventory-manager

## Phase Summary (0–7)

This repository uses `node-pg-migrate` with timestamped TypeScript migrations. All phases are implemented:

- Phase 0: Core ledger (`items`, `locations`, `inventory_movements`, `inventory_movement_lines`, `audit_log`)
- Phase 1: Vendors, POs, Receiving, QC, Putaway, Inbound Closeout
- Phase 2: Inventory Adjustments, Cycle Counts
- Phase 3: BOMs (effective/versions), Work Orders, Work Order Execution (issue/produce)
- Phase 4: Order-to-Cash docs (customers, sales orders, shipments, POS, reservations, returns) — DB-only
- Phase 5: Planning read-models (MPS/MRP/Replenishment/KPIs) — DB-only
- Phase 6: DRP network/runs/plan lines/planned transfers — DB-only
- Phase 7: Compliance/traceability (lots, lot links, recall docs, KPI snapshots) — DB-only

Ledger authority remains solely in `inventory_movements` + `inventory_movement_lines`; no table stores on-hand balances. DB-only phases (4–7) add reporting/planning schema only and do not change execution semantics.

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
5. `psql "$DATABASE_URL" -c "\\dt *kpi_runs* *drp_* *mps_* *mrp_* *replenishment_* *lots* *recall_*"` — DB-only phases 4–7 schemas should be present without errors.

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
- `POST /purchase-order-receipts`, `GET /purchase-order-receipts/:id`, `GET /purchase-order-receipts/:id/reconciliation`
- `POST /qc-events`, `GET /purchase-order-receipt-lines/:id/qc-events`
- `POST /putaways`, `GET /putaways/:id`, `POST /putaways/:id/post`
- `POST /purchase-order-receipts/:id/close`, `POST /purchase-orders/:id/close`
- `POST /inventory-adjustments`, `GET /inventory-adjustments/:id`, `POST /inventory-adjustments/:id/post`
- `POST /inventory-counts`, `GET /inventory-counts/:id`, `POST /inventory-counts/:id/post`
- `POST /boms`, `GET /boms/:id`, `GET /items/:id/boms`, `POST /boms/:id/activate`, `GET /items/:id/bom?asOf=ISO_DATE`
- `POST /work-orders`, `GET /work-orders/:id`, `GET /work-orders`
- `POST /work-orders/:id/issues`, `POST /work-orders/:id/issues/:issueId/post`
- `POST /work-orders/:id/completions`, `POST /work-orders/:id/completions/:completionId/post`
- `GET /work-orders/:id/execution`

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

# 10) Inspect receipt reconciliation before closing (should show zero remaining)
curl -s http://localhost:3000/purchase-order-receipts/<RECEIPT_ID>/reconciliation | jq .

# 11) Close the receipt (will fail if QC/putaway rules are violated)
curl -s -X POST http://localhost:3000/purchase-order-receipts/<RECEIPT_ID>/close \
  -H 'Content-Type: application/json' \
  -d '{"actorType":"user","actorId":"closer-1","notes":"QA verified"}' | jq .

# 12) Close the purchase order (all receipts must be closed first)
curl -s -X POST http://localhost:3000/purchase-orders/<PO_ID>/close | jq .

# 13) Verify inventory movements show the transfer
psql "$DATABASE_URL" -c "
SELECT item_id, location_id, uom, SUM(quantity_delta) AS on_hand
FROM inventory_movement_lines
GROUP BY item_id, location_id, uom
ORDER BY location_id;
"

# 14) Inspect receipt closeout + PO status in SQL
psql "$DATABASE_URL" -c "SELECT id, status, closed_at FROM inbound_closeouts;"
psql "$DATABASE_URL" -c "SELECT id, status FROM purchase_orders WHERE id = '<PO_ID>';"

# 15) Create an inventory adjustment that adds stock to the bin
curl -s -X POST http://localhost:3000/inventory-adjustments \
  -H 'Content-Type: application/json' \
  -d '{
    "occurredAt": "2024-01-16T12:00:00Z",
    "lines": [
      {
        "itemId": "<ITEM_UUID>",
        "locationId": "<BIN_LOCATION_UUID>",
        "uom": "kg",
        "quantityDelta": 5,
        "reasonCode": "found"
      }
    ]
  }' | jq .

# 16) Post the adjustment
curl -s -X POST http://localhost:3000/inventory-adjustments/<ADJUSTMENT_ID>/post | jq .

# 17) Create and post an adjustment that removes stock
curl -s -X POST http://localhost:3000/inventory-adjustments \
  -H 'Content-Type: application/json' \
  -d '{
    "occurredAt": "2024-01-17T12:00:00Z",
    "notes": "Shrink adjustment",
    "lines": [
      {
        "itemId": "<ITEM_UUID>",
        "locationId": "<BIN_LOCATION_UUID>",
        "uom": "kg",
        "quantityDelta": -3,
        "reasonCode": "shrink"
      }
    ]
  }' | jq .

curl -s -X POST http://localhost:3000/inventory-adjustments/<SECOND_ADJUSTMENT_ID>/post | jq .

# 18) Verify on-hand reflects the adjustments (net +2 kg after +5/-3)
psql "$DATABASE_URL" -c "
SELECT item_id, location_id, uom, SUM(quantity_delta) AS on_hand
FROM inventory_movement_lines
WHERE item_id = '<ITEM_UUID>' AND location_id = '<BIN_LOCATION_UUID>'
GROUP BY item_id, location_id, uom;
"

# 19) Create a cycle count (counted quantity different from current on-hand)
curl -s -X POST http://localhost:3000/inventory-counts \
  -H 'Content-Type: application/json' \
  -d '{
    "countedAt": "2024-01-18T10:00:00Z",
    "locationId": "<BIN_LOCATION_UUID>",
    "lines": [
      {"itemId": "<ITEM_UUID>", "uom": "kg", "countedQuantity": 7}
    ]
  }' | jq .

# 20) Inspect the count with variance summary
curl -s http://localhost:3000/inventory-counts/<COUNT_ID> | jq .

# 21) Post the cycle count
curl -s -X POST http://localhost:3000/inventory-counts/<COUNT_ID>/post | jq .

# 22) Verify a `movement_type='count'` entry exists and on-hand now equals the counted quantity
psql "$DATABASE_URL" -c "
SELECT m.id, m.movement_type, m.occurred_at, l.quantity_delta
FROM inventory_movements m
JOIN inventory_movement_lines l ON l.movement_id = m.id
WHERE m.movement_type = 'count'
ORDER BY m.created_at DESC
LIMIT 10;
"

psql "$DATABASE_URL" -c "
SELECT item_id, location_id, uom, SUM(quantity_delta) AS on_hand
FROM inventory_movement_lines
WHERE item_id = '<ITEM_UUID>' AND location_id = '<BIN_LOCATION_UUID>'
GROUP BY item_id, location_id, uom;
"
```

Successful responses confirm vendors/POs work end-to-end, receipts insert atomically, QC events enforce the service validations, putaway posting creates balanced transfer movements, reconciliation detects blockers, closeout endpoints enforce the gating rules, inventory adjustments correct stock with immutable movements, and cycle counts recompute on-hand via `movement_type='count'` deltas.

## Phase 3 — Feature 1 BOM / Recipe Management

### Smoke test / manual verification

Run the steps below after applying the Phase 3 Feature 1 migrations.

```bash
# 0) Insert sample items (one finished good and at least one component; the example adds packaging for a second component line)
psql "$DATABASE_URL" -c "INSERT INTO items (id, sku, name, active, created_at, updated_at) VALUES ('<FINISHED_ITEM_ID>', 'FG-CHOCO', 'Finished Chocolate Bar', true, now(), now());"
psql "$DATABASE_URL" -c "INSERT INTO items (id, sku, name, active, created_at, updated_at) VALUES ('<COMPONENT_ITEM_ID>', 'RM-COCOA', 'Raw Cocoa', true, now(), now());"
psql "$DATABASE_URL" -c "INSERT INTO items (id, sku, name, active, created_at, updated_at) VALUES ('<SECOND_COMPONENT_ID>', 'PKG-BAR', 'Bar Wrapper', true, now(), now());"

# 1) Create BOM v1 with two component lines
curl -s -X POST http://localhost:3000/boms \
  -H 'Content-Type: application/json' \
  -d '{
    "bomCode": "BOM-CHOCO-001",
    "outputItemId": "<FINISHED_ITEM_ID>",
    "defaultUom": "kg",
    "version": {
      "versionNumber": 1,
      "yieldQuantity": 100,
      "yieldUom": "kg",
      "components": [
        {"lineNumber": 1, "componentItemId": "<COMPONENT_ITEM_ID>", "uom": "kg", "quantityPer": 80},
        {"lineNumber": 2, "componentItemId": "<SECOND_COMPONENT_ID>", "uom": "ea", "quantityPer": 100, "scrapFactor": 0.02}
      ]
    }
  }' | jq .

# 2) List BOMs for the finished item (shows draft version)
curl -s http://localhost:3000/items/<FINISHED_ITEM_ID>/boms | jq .

# 3) Activate the version (use the version id returned from step 1)
curl -s -X POST http://localhost:3000/boms/<BOM_VERSION_ID>/activate \
  -H 'Content-Type: application/json' \
  -d '{"effectiveFrom":"2024-02-01T00:00:00Z"}' | jq '.versions'

# 4) Fetch the BOM with components to confirm status flipped to active
curl -s http://localhost:3000/boms/<BOM_ID> | jq '.versions'

# 5) Resolve the effective BOM for an as-of date (defaults to now when asOf is omitted)
curl -s "http://localhost:3000/items/<FINISHED_ITEM_ID>/bom?asOf=2024-02-15T00:00:00Z" | jq .

# 6) Try to create a duplicate BOM code (should return 409)
curl -s -X POST http://localhost:3000/boms \
  -H 'Content-Type: application/json' \
  -d '{
    "bomCode": "BOM-CHOCO-001",
    "outputItemId": "<FINISHED_ITEM_ID>",
    "defaultUom": "kg",
    "version": {
      "yieldQuantity": 100,
      "yieldUom": "kg",
      "components": [
        {"lineNumber": 1, "componentItemId": "<COMPONENT_ITEM_ID>", "uom": "kg", "quantityPer": 80}
      ]
    }
  }' | jq .

# 7) Create a second BOM for the same finished item and attempt to activate it with an overlapping effective range (should return 409)
SECOND_BOM=$(curl -s -X POST http://localhost:3000/boms \
  -H 'Content-Type: application/json' \
  -d "{
    \"bomCode\": \"BOM-CHOCO-002\",
    \"outputItemId\": \"<FINISHED_ITEM_ID>\",
    \"defaultUom\": \"kg\",
    \"version\": {
      \"versionNumber\": 1,
      \"yieldQuantity\": 100,
      \"yieldUom\": \"kg\",
      \"components\": [
        {\"lineNumber\": 1, \"componentItemId\": \"<COMPONENT_ITEM_ID>\", \"uom\": \"kg\", \"quantityPer\": 70}
      ]
    }
  }")
SECOND_VERSION_ID=$(echo "$SECOND_BOM" | jq -r '.versions[0].id')
curl -s -X POST http://localhost:3000/boms/$SECOND_VERSION_ID/activate \
  -H 'Content-Type: application/json' \
  -d '{"effectiveFrom":"2024-02-10T00:00:00Z"}' | jq .

# 8) Activate the second BOM with a non-overlapping date to confirm the guard rails
curl -s -X POST http://localhost:3000/boms/$SECOND_VERSION_ID/activate \
  -H 'Content-Type: application/json' \
  -d '{"effectiveFrom":"2024-03-01T00:00:00Z"}' | jq '.versions'

# 9) Query the effective BOM again for different as-of dates to ensure the correct version is selected
curl -s "http://localhost:3000/items/<FINISHED_ITEM_ID>/bom?asOf=2024-02-15T00:00:00Z" | jq '.version.versionNumber'
curl -s "http://localhost:3000/items/<FINISHED_ITEM_ID>/bom?asOf=2024-03-15T00:00:00Z" | jq '.version.versionNumber'
```

These steps validate that BOM creation inserts headers and components atomically, activation enforces single-active effective ranges per finished item, duplicate BOM codes are rejected, and the `GET /items/:id/bom?asOf=...` lookup returns the correct version for any date. If any of the validation steps return 4xx/5xx responses other than the expected 409 conflict checks, inspect the API logs and database contents before proceeding.

## Phase 3 — Feature 2 & 3 Work Orders + Execution (Issue-to-Work-Order)

### Smoke test / manual verification

Run the steps below after Phase 3 Feature 1 BOM creation/activation.

```bash
# 0) Create a work order referencing the BOM (use the BOM id + active version id from the BOM smoke test)
curl -s -X POST http://localhost:3000/work-orders \
  -H 'Content-Type: application/json' \
  -d '{
    "workOrderNumber": "WO-0001",
    "bomId": "<BOM_ID>",
    "bomVersionId": "<BOM_VERSION_ID>",
    "outputItemId": "<FINISHED_ITEM_ID>",
    "outputUom": "kg",
    "quantityPlanned": 100,
    "scheduledStartAt": "2024-02-20T08:00:00Z",
    "scheduledDueAt": "2024-02-21T08:00:00Z",
    "notes": "First production run"
  }' | jq .

# 1) Fetch by id
curl -s http://localhost:3000/work-orders/<WORK_ORDER_ID> | jq .

# 2) List work orders with paging + status filter
curl -s "http://localhost:3000/work-orders?status=draft&limit=10&offset=0" | jq .

# 3) Add component stock via adjustment at a source location (fromLocationId below)
psql "$DATABASE_URL" -c "INSERT INTO locations (id, code, name, type, active, created_at, updated_at) VALUES ('<COMPONENT_LOC_ID>', 'RM-BIN-1', 'Raw Material Bin', 'bin', true, now(), now());"
curl -s -X POST http://localhost:3000/inventory-adjustments \
  -H 'Content-Type: application/json' \
  -d '{
    "occurredAt": "2024-02-20T07:00:00Z",
    "notes": "Seed component inventory",
    "lines": [
      {"itemId": "<COMPONENT_ITEM_ID>", "locationId": "<COMPONENT_LOC_ID>", "uom": "kg", "quantityDelta": 500, "reasonCode": "seed"}
    ]
  }' | jq .
curl -s -X POST http://localhost:3000/inventory-adjustments/<ADJUSTMENT_ID>/post | jq .

# 4) Create a draft issue document for the work order
curl -s -X POST http://localhost:3000/work-orders/<WORK_ORDER_ID>/issues \
  -H 'Content-Type: application/json' \
  -d '{
    "occurredAt": "2024-02-20T09:00:00Z",
    "notes": "Issue cocoa",
    "lines": [
      {"lineNumber": 1, "componentItemId": "<COMPONENT_ITEM_ID>", "fromLocationId": "<COMPONENT_LOC_ID>", "uom": "kg", "quantityIssued": 80}
    ]
  }' | jq .

# 5) Post the issue (creates one movement_type='issue' with negative deltas)
curl -s -X POST http://localhost:3000/work-orders/<WORK_ORDER_ID>/issues/<ISSUE_ID>/post | jq .

# 6) Create a completion draft (toLocationId is where finished goods land)
psql "$DATABASE_URL" -c "INSERT INTO locations (id, code, name, type, active, created_at, updated_at) VALUES ('<FG_LOC_ID>', 'FG-BIN-1', 'Finished Goods Bin', 'bin', true, now(), now());"
curl -s -X POST http://localhost:3000/work-orders/<WORK_ORDER_ID>/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "occurredAt": "2024-02-20T12:00:00Z",
    "notes": "Produced finished goods",
    "lines": [
      {"outputItemId": "<FINISHED_ITEM_ID>", "toLocationId": "<FG_LOC_ID>", "uom": "kg", "quantityCompleted": 100}
    ]
  }' | jq .

# 7) Post the completion (creates one movement_type='receive' with positive deltas and updates WO quantity_completed)
curl -s -X POST http://localhost:3000/work-orders/<WORK_ORDER_ID>/completions/<COMPLETION_ID>/post | jq .

# 8) Verify inventory deltas
psql "$DATABASE_URL" -c "
SELECT item_id, location_id, uom, SUM(quantity_delta) AS on_hand
FROM inventory_movement_lines
WHERE (item_id, location_id) IN (('<COMPONENT_ITEM_ID>', '<COMPONENT_LOC_ID>'), ('<FINISHED_ITEM_ID>', '<FG_LOC_ID>'))
GROUP BY item_id, location_id, uom;
"

# 9) Execution summary
curl -s http://localhost:3000/work-orders/<WORK_ORDER_ID>/execution | jq .
```
