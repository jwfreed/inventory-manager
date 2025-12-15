# Implementation Layer — Phase 4 (Features 1–5)

This document translates the Phase 4 specifications into an ordered PostgreSQL migration plan covering:

1. Sales orders
2. POS ingestion
3. Reservations / allocations
4. Pick / pack / ship execution docs
5. Returns & disposition

Design goals:
- Keep `inventory_movements` as the sole on-hand authority.
- Document tables, indexes, and DB-enforceable constraints.
- Enumerate validations that must remain in the service layer.

Dependencies: Phase 0 base tables (`items`, `locations`, `inventory_movements`, `audit_log`). No hard dependency on Phase 3 at the DB layer.

---

## Ordered Migration Plan

### Migration 1 — `customers`

```sql
CREATE TABLE customers (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    email text,
    phone text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_customers_active ON customers(active);
```

### Migration 2 — `sales_orders`

```sql
CREATE TABLE sales_orders (
    id uuid PRIMARY KEY,
    so_number text NOT NULL UNIQUE,
    customer_id uuid NOT NULL REFERENCES customers(id),
    status text NOT NULL,
    order_date date,
    requested_ship_date date,
    ship_from_location_id uuid REFERENCES locations(id),
    customer_reference text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE sales_orders
    ADD CONSTRAINT chk_sales_orders_status
        CHECK (status IN ('draft','submitted','partially_shipped','shipped','closed','canceled'));
CREATE INDEX idx_sales_orders_customer_status ON sales_orders(customer_id, status);
CREATE INDEX idx_sales_orders_created_at ON sales_orders(created_at);
```

### Migration 3 — `sales_order_lines`

```sql
CREATE TABLE sales_order_lines (
    id uuid PRIMARY KEY,
    sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_ordered numeric(18,6) NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sales_order_id, line_number)
);
ALTER TABLE sales_order_lines
    ADD CONSTRAINT chk_so_lines_qty_positive CHECK (quantity_ordered > 0);
CREATE INDEX idx_so_lines_order ON sales_order_lines(sales_order_id);
CREATE INDEX idx_so_lines_item ON sales_order_lines(item_id);
```

### Migration 4 — `sales_order_shipments`

```sql
CREATE TABLE sales_order_shipments (
    id uuid PRIMARY KEY,
    sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
    shipped_at timestamptz NOT NULL,
    ship_from_location_id uuid REFERENCES locations(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    external_ref text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipments_order_shipped_at ON sales_order_shipments(sales_order_id, shipped_at);
CREATE INDEX idx_shipments_movement ON sales_order_shipments(inventory_movement_id);
```

Optional DB enforcement (matches docs):

```sql
CREATE UNIQUE INDEX idx_shipments_movement_unique
    ON sales_order_shipments(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
```

### Migration 5 — `sales_order_shipment_lines`

```sql
CREATE TABLE sales_order_shipment_lines (
    id uuid PRIMARY KEY,
    sales_order_shipment_id uuid NOT NULL REFERENCES sales_order_shipments(id) ON DELETE CASCADE,
    sales_order_line_id uuid NOT NULL REFERENCES sales_order_lines(id),
    uom text NOT NULL,
    quantity_shipped numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sales_order_shipment_lines
    ADD CONSTRAINT chk_shipment_lines_qty_positive CHECK (quantity_shipped > 0);
CREATE INDEX idx_shipment_lines_shipment ON sales_order_shipment_lines(sales_order_shipment_id);
CREATE INDEX idx_shipment_lines_line ON sales_order_shipment_lines(sales_order_line_id);
```

### Migration 6 — `pos_sources`

```sql
CREATE TABLE pos_sources (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_pos_sources_active ON pos_sources(active);
```

### Migration 7 — `pos_transactions`

```sql
CREATE TABLE pos_transactions (
    id uuid PRIMARY KEY,
    pos_source_id uuid NOT NULL REFERENCES pos_sources(id),
    external_transaction_id text NOT NULL,
    transaction_type text NOT NULL,
    status text NOT NULL,
    occurred_at timestamptz NOT NULL,
    store_location_id uuid REFERENCES locations(id),
    currency text,
    raw_payload jsonb,
    notes text,
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE pos_transactions
    ADD CONSTRAINT chk_pos_transactions_type
        CHECK (transaction_type IN ('sale','return','void'));
ALTER TABLE pos_transactions
    ADD CONSTRAINT chk_pos_transactions_status
        CHECK (status IN ('ingested','posted','rejected'));
CREATE UNIQUE INDEX idx_pos_transactions_source_ext
    ON pos_transactions(pos_source_id, external_transaction_id);
CREATE INDEX idx_pos_transactions_status ON pos_transactions(status, occurred_at);
```

### Migration 8 — `pos_transaction_lines`

```sql
CREATE TABLE pos_transaction_lines (
    id uuid PRIMARY KEY,
    pos_transaction_id uuid NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    external_line_id text,
    external_sku text,
    item_id uuid REFERENCES items(id),
    uom text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pos_transaction_id, line_number)
);
ALTER TABLE pos_transaction_lines
    ADD CONSTRAINT chk_pos_transaction_lines_qty CHECK (quantity > 0);
CREATE INDEX idx_pos_transaction_lines_item ON pos_transaction_lines(item_id);
CREATE INDEX idx_pos_transaction_lines_external_sku ON pos_transaction_lines(external_sku);
```

### Migration 9 — `inventory_reservations`

```sql
CREATE TABLE inventory_reservations (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    demand_type text NOT NULL,
    demand_id uuid NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    location_id uuid NOT NULL REFERENCES locations(id),
    uom text NOT NULL,
    quantity_reserved numeric(18,6) NOT NULL,
    quantity_fulfilled numeric(18,6),
    reserved_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    release_reason_code text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    UNIQUE (demand_type, demand_id, item_id, location_id, uom)
);
ALTER TABLE inventory_reservations
    ADD CONSTRAINT chk_reservation_status
        CHECK (status IN ('open','released','fulfilled','canceled'));
ALTER TABLE inventory_reservations
    ADD CONSTRAINT chk_reservation_demand_type
        CHECK (demand_type IN ('sales_order_line'));
ALTER TABLE inventory_reservations
    ADD CONSTRAINT chk_reservation_quantities
        CHECK (quantity_reserved > 0 AND (quantity_fulfilled IS NULL OR quantity_fulfilled >= 0));
CREATE INDEX idx_reservations_item_location ON inventory_reservations(item_id, location_id, uom);
CREATE INDEX idx_reservations_demand ON inventory_reservations(demand_type, demand_id);
```

### Migration 10 — `pick_batches`

```sql
CREATE TABLE pick_batches (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    pick_type text NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE pick_batches
    ADD CONSTRAINT chk_pick_batches_status
        CHECK (status IN ('draft','released','in_progress','completed','canceled'));
ALTER TABLE pick_batches
    ADD CONSTRAINT chk_pick_batches_type
        CHECK (pick_type IN ('single_order','batch'));
CREATE INDEX idx_pick_batches_status ON pick_batches(status);
```

### Migration 11 — `pick_tasks`

```sql
CREATE TABLE pick_tasks (
    id uuid PRIMARY KEY,
    pick_batch_id uuid NOT NULL REFERENCES pick_batches(id) ON DELETE CASCADE,
    status text NOT NULL,
    inventory_reservation_id uuid REFERENCES inventory_reservations(id),
    sales_order_line_id uuid REFERENCES sales_order_lines(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    from_location_id uuid NOT NULL REFERENCES locations(id),
    quantity_requested numeric(18,6) NOT NULL,
    quantity_picked numeric(18,6),
    picked_at timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE pick_tasks
    ADD CONSTRAINT chk_pick_tasks_status
        CHECK (status IN ('pending','picked','short','canceled'));
CREATE INDEX idx_pick_tasks_batch_status ON pick_tasks(pick_batch_id, status);
CREATE INDEX idx_pick_tasks_reservation ON pick_tasks(inventory_reservation_id);
CREATE INDEX idx_pick_tasks_sales_order_line ON pick_tasks(sales_order_line_id);
```

### Migration 12 — `packs`

```sql
CREATE TABLE packs (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    sales_order_shipment_id uuid NOT NULL REFERENCES sales_order_shipments(id),
    package_ref text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE packs
    ADD CONSTRAINT chk_packs_status CHECK (status IN ('open','sealed','canceled'));
CREATE INDEX idx_packs_shipment ON packs(sales_order_shipment_id);
```

### Migration 13 — `pack_lines`

```sql
CREATE TABLE pack_lines (
    id uuid PRIMARY KEY,
    pack_id uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
    pick_task_id uuid REFERENCES pick_tasks(id),
    sales_order_line_id uuid NOT NULL REFERENCES sales_order_lines(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_packed numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pack_lines
    ADD CONSTRAINT chk_pack_lines_qty CHECK (quantity_packed > 0);
CREATE INDEX idx_pack_lines_pack ON pack_lines(pack_id);
CREATE INDEX idx_pack_lines_so_line ON pack_lines(sales_order_line_id);
``>

### Migration 14 — `return_authorizations` (RMAs)

```sql
CREATE TABLE return_authorizations (
    id uuid PRIMARY KEY,
    rma_number text NOT NULL UNIQUE,
    customer_id uuid NOT NULL REFERENCES customers(id),
    sales_order_id uuid REFERENCES sales_orders(id),
    status text NOT NULL,
    severity text,
    authorized_at timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE return_authorizations
    ADD CONSTRAINT chk_rma_status
        CHECK (status IN ('draft','authorized','closed','canceled'));
CREATE INDEX idx_rmas_customer_status ON return_authorizations(customer_id, status);
```

### Migration 15 — `return_authorization_lines`

```sql
CREATE TABLE return_authorization_lines (
    id uuid PRIMARY KEY,
    return_authorization_id uuid NOT NULL REFERENCES return_authorizations(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    sales_order_line_id uuid REFERENCES sales_order_lines(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_authorized numeric(18,6) NOT NULL,
    reason_code text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (return_authorization_id, line_number)
);
ALTER TABLE return_authorization_lines
    ADD CONSTRAINT chk_rma_lines_qty CHECK (quantity_authorized > 0);
```

### Migration 16 — `return_receipts`

```sql
CREATE TABLE return_receipts (
    id uuid PRIMARY KEY,
    return_authorization_id uuid NOT NULL REFERENCES return_authorizations(id),
    status text NOT NULL,
    received_at timestamptz NOT NULL,
    received_to_location_id uuid NOT NULL REFERENCES locations(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    external_ref text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE return_receipts
    ADD CONSTRAINT chk_return_receipts_status
        CHECK (status IN ('draft','posted','canceled'));
CREATE UNIQUE INDEX idx_return_receipts_movement
    ON return_receipts(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
CREATE INDEX idx_return_receipts_rma ON return_receipts(return_authorization_id, received_at);
```

### Migration 17 — `return_receipt_lines`

```sql
CREATE TABLE return_receipt_lines (
    id uuid PRIMARY KEY,
    return_receipt_id uuid NOT NULL REFERENCES return_receipts(id) ON DELETE CASCADE,
    return_authorization_line_id uuid REFERENCES return_authorization_lines(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_received numeric(18,6) NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE return_receipt_lines
    ADD CONSTRAINT chk_return_receipt_lines_qty CHECK (quantity_received > 0);
CREATE INDEX idx_return_receipt_lines_receipt ON return_receipt_lines(return_receipt_id);
```

### Migration 18 — `return_dispositions`

```sql
CREATE TABLE return_dispositions (
    id uuid PRIMARY KEY,
    return_receipt_id uuid NOT NULL REFERENCES return_receipts(id),
    status text NOT NULL,
    occurred_at timestamptz NOT NULL,
    disposition_type text NOT NULL,
    from_location_id uuid NOT NULL REFERENCES locations(id),
    to_location_id uuid REFERENCES locations(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE return_dispositions
    ADD CONSTRAINT chk_return_dispositions_status
        CHECK (status IN ('draft','posted','canceled'));
ALTER TABLE return_dispositions
    ADD CONSTRAINT chk_return_dispositions_type
        CHECK (disposition_type IN ('restock','scrap','quarantine_hold'));
CREATE UNIQUE INDEX idx_return_dispositions_movement
    ON return_dispositions(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
```

### Migration 19 — `return_disposition_lines`

```sql
CREATE TABLE return_disposition_lines (
    id uuid PRIMARY KEY,
    return_disposition_id uuid NOT NULL REFERENCES return_dispositions(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (return_disposition_id, line_number)
);
ALTER TABLE return_disposition_lines
    ADD CONSTRAINT chk_return_disposition_lines_qty CHECK (quantity > 0);
CREATE INDEX idx_return_disposition_lines_item ON return_disposition_lines(item_id);
```

---

## Validations Remaining in the Service Layer

The following invariants/subtleties must be handled in application logic:

1. **Sales order lifecycle and shipment posting**
   - Enforcing status transitions, draft vs posted shipments, over-ship policies, and linking shipments to posted issue movements atomically.

2. **UOM equality**
   - Ensuring shipment lines’ `uom` matches sales order lines’ `uom` and receipt lines match their order lines (cannot be enforced cross-table).

3. **Reservation logic**
   - Ensuring `quantity_fulfilled` updates when shipments post; preventing over-reservation or under-reservation is policy-level logic.

4. **Pick/pack completion rules**
   - Service layer must enforce: pick tasks link to either reservation or SO line (not both); pack lines don’t exceed picked qty; sealed packs block edits.

5. **Shipment quantity source of truth**
   - Movement lines vs pack lines vs shipment lines must reconcile; DB cannot cross-check across tables automatically.

6. **POS posting semantics**
   - Ensuring dedupe by `(pos_source_id, external_transaction_id)` plus posting/issue movement linkage is atomic.

7. **Return disposition semantics**
   - Mapping disposition type to correct movement behavior plus ensuring `occurred_at` falls within recall window (if applicable) is service logic.

8. **Action vs movement linking (phase 4 docs)**
   - Also part of recall workflows (Phase 7); but these Phase 4 tables assume service-layer checks around linking to `inventory_movements`.

This plan enumerates the database changes needed for Phase 4 while explicitly documenting what remains a service responsibility.***
