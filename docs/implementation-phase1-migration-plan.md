# Implementation Layer — Phase 1 Features 1–4

This document describes the **PostgreSQL migration plan** for Phase 1 features:

1. Feature 1 — Purchase orders
2. Feature 2 — Receiving + QC hold/release
3. Feature 3 — Putaway
4. Feature 4 — Inbound closeout

For each step, it lists tables, indexes, and DB-enforceable constraints, plus validations that must remain in the service layer. Ordered migrations assume Phase 0 migrations are already applied.

---

## Ordered Migration Plan

### Migration 1 — `vendors`

```sql
CREATE TABLE vendors (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    email text,
    phone text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_vendors_active ON vendors(active);
```

### Migration 2 — `purchase_orders`

```sql
CREATE TABLE purchase_orders (
    id uuid PRIMARY KEY,
    po_number text NOT NULL UNIQUE,
    vendor_id uuid NOT NULL REFERENCES vendors(id),
    status text NOT NULL,
    order_date date,
    expected_date date,
    ship_to_location_id uuid REFERENCES locations(id),
    vendor_reference text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_po_vendor_status ON purchase_orders(vendor_id, status);
CREATE INDEX idx_po_created_at ON purchase_orders(created_at);
ALTER TABLE purchase_orders
    ADD CONSTRAINT chk_purchase_orders_status
        CHECK (status IN ('draft','submitted','partially_received','received','closed','canceled'));
```

### Migration 3 — `purchase_order_lines`

```sql
CREATE TABLE purchase_order_lines (
    id uuid PRIMARY KEY,
    purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_ordered numeric(18,6) NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (purchase_order_id, line_number)
);
ALTER TABLE purchase_order_lines
    ADD CONSTRAINT chk_po_lines_qty_positive CHECK (quantity_ordered > 0);
CREATE INDEX idx_po_lines_po_id ON purchase_order_lines(purchase_order_id);
CREATE INDEX idx_po_lines_item_id ON purchase_order_lines(item_id);
```

### Migration 4 — `purchase_order_receipts`

```sql
CREATE TABLE purchase_order_receipts (
    id uuid PRIMARY KEY,
    purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
    received_at timestamptz NOT NULL,
    received_to_location_id uuid REFERENCES locations(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    external_ref text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_receipts_po_id_on_at ON purchase_order_receipts(purchase_order_id, received_at);
CREATE INDEX idx_po_receipts_movement_id ON purchase_order_receipts(inventory_movement_id);
```

### Migration 5 — `purchase_order_receipt_lines`

```sql
CREATE TABLE purchase_order_receipt_lines (
    id uuid PRIMARY KEY,
    purchase_order_receipt_id uuid NOT NULL REFERENCES purchase_order_receipts(id) ON DELETE CASCADE,
    purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_lines(id),
    uom text NOT NULL,
    quantity_received numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purchase_order_receipt_lines
    ADD CONSTRAINT chk_po_receipt_lines_qty_positive CHECK (quantity_received > 0);
CREATE INDEX idx_po_receipt_lines_receipt_id ON purchase_order_receipt_lines(purchase_order_receipt_id);
CREATE INDEX idx_po_receipt_lines_line_id ON purchase_order_receipt_lines(purchase_order_line_id);
```

### Migration 6 — `qc_events`

```sql
CREATE TABLE qc_events (
    id uuid PRIMARY KEY,
    purchase_order_receipt_line_id uuid NOT NULL REFERENCES purchase_order_receipt_lines(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    uom text NOT NULL,
    reason_code text,
    notes text,
    actor_type text NOT NULL,
    actor_id text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qc_events
    ADD CONSTRAINT chk_qc_event_type CHECK (event_type IN ('hold','accept','reject'));
ALTER TABLE qc_events
    ADD CONSTRAINT chk_qc_event_quantity CHECK (quantity > 0);
ALTER TABLE qc_events
    ADD CONSTRAINT chk_qc_actor_type CHECK (actor_type IN ('user','system'));
CREATE INDEX idx_qc_events_receipt_line ON qc_events(purchase_order_receipt_line_id, occurred_at);
CREATE INDEX idx_qc_events_event_type ON qc_events(event_type, occurred_at);
```

### Migration 7 — `qc_inventory_links`

```sql
CREATE TABLE qc_inventory_links (
    id uuid PRIMARY KEY,
    qc_event_id uuid NOT NULL REFERENCES qc_events(id) ON DELETE CASCADE,
    inventory_movement_id uuid NOT NULL REFERENCES inventory_movements(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (qc_event_id)
);
CREATE INDEX idx_qc_inventory_links_movement_id ON qc_inventory_links(inventory_movement_id);
```

### Migration 8 — `purchase_order_receipt_lines` QC status columns

```sql
ALTER TABLE purchase_order_receipt_lines
    ADD COLUMN qc_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN qc_updated_at timestamptz;
ALTER TABLE purchase_order_receipt_lines
    ADD CONSTRAINT chk_po_receipt_lines_qc_status
        CHECK (qc_status IN ('pending','held','accepted','rejected'));
CREATE INDEX idx_po_receipt_lines_qc_status ON purchase_order_receipt_lines(qc_status);
```

### Migration 9 — `putaways`

```sql
CREATE TABLE putaways (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    source_type text NOT NULL,
    purchase_order_receipt_id uuid REFERENCES purchase_order_receipts(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE putaways
    ADD CONSTRAINT chk_putaways_status
        CHECK (status IN ('draft','in_progress','completed','canceled'));
ALTER TABLE putaways
    ADD CONSTRAINT chk_putaways_source_type
        CHECK (source_type IN ('purchase_order_receipt','qc','manual'));
CREATE INDEX idx_putaways_status ON putaways(status);
CREATE INDEX idx_putaways_receipt ON putaways(purchase_order_receipt_id);
```

### Migration 10 — `putaway_lines`

```sql
CREATE TABLE putaway_lines (
    id uuid PRIMARY KEY,
    putaway_id uuid NOT NULL REFERENCES putaways(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_planned numeric(18,6),
    quantity_moved numeric(18,6),
    from_location_id uuid NOT NULL REFERENCES locations(id),
    to_location_id uuid NOT NULL REFERENCES locations(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    status text NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    UNIQUE (putaway_id, line_number)
);
ALTER TABLE putaway_lines
    ADD CONSTRAINT chk_putaway_lines_status CHECK (status IN ('pending','completed','canceled'));
ALTER TABLE putaway_lines
    ADD CONSTRAINT chk_putaway_lines_locations CHECK (from_location_id <> to_location_id);
```

### Migration 11 — `inbound_closeouts`

```sql
CREATE TABLE inbound_closeouts (
    id uuid PRIMARY KEY,
    purchase_order_receipt_id uuid NOT NULL REFERENCES purchase_order_receipts(id),
    status text NOT NULL,
    closed_at timestamptz,
    closed_by_actor_type text,
    closed_by_actor_id text,
    closeout_reason_code text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE inbound_closeouts
    ADD CONSTRAINT chk_inbound_closeouts_status
        CHECK (status IN ('open','closed','reopened'));
ALTER TABLE inbound_closeouts
    ADD CONSTRAINT chk_inbound_closeouts_actor_type
        CHECK (closed_by_actor_type IS NULL OR closed_by_actor_type IN ('user','system'));
CREATE UNIQUE INDEX idx_inbound_closeouts_receipt
    ON inbound_closeouts(purchase_order_receipt_id);
```

### Migration 12 — Optional: `inbound_closeout_snapshots`

```sql
CREATE TABLE inbound_closeout_snapshots (
    id uuid PRIMARY KEY,
    inbound_closeout_id uuid NOT NULL REFERENCES inbound_closeouts(id) ON DELETE CASCADE,
    snapshot_at timestamptz NOT NULL DEFAULT now(),
    data jsonb NOT NULL,
    UNIQUE (inbound_closeout_id)
);
```

---

## Validations Remaining in the Service Layer

The following rules cannot be enforced solely by PostgreSQL and must remain in application logic:

1. **Purchase order status transitions**
   - Enforcing multistep lifecycle (draft→submitted→…); DB only checks allowed values.

2. **Shipment/receipt posting semantics**
   - Posting a receipt must be atomic with linking to a posted movement; DB cannot enforce this transactionally.

3. **UOM equality**
   - Cross-table equality (e.g., receipt line UOM matches PO line UOM) can’t be enforced via constraint; must be validated before insert/update.

4. **QC invariants**
   - Summation of QC event quantities not exceeding receipt line quantity.
   - Deriving `qc_status` via posting-time rules (pending/held/accepted/rejected).

5. **Putaway completion rules**
   - Enforcing that completed lines have `quantity_moved > 0` and link to a posted transfer movement.
   - Ensuring no `pending` lines remain when `putaways.status='completed'`.

6. **Inbound closeout preconditions**
   - Checking QC/putaway completion before closing.

7. **Location hierarchy cycle prevention** (already documented in Phase 0; still service-layer).

8. **Audit log vocabulary** (Phase 0; remains service-layer).

These migrations lay the database foundation for Phase 1 features while documenting the invariants that must be validated in code or service workflows.
