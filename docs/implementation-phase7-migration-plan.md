# Implementation Layer — Phase 7 (Compliance & Reporting)

Scope: Database migrations only. Phase 7 introduces reporting and governance artifacts for:
- KPIs and reporting snapshots
- Lot-level traceability
- Recall execution documentation

All tables are append-only reporting data. They do **not** move or reconcile inventory.

Dependencies: Phase 0–6 tables (items, locations, inventory_movements, work order docs, etc.).

---

## Ordered Migration Plan

### Migration 1 — `lots`

```sql
CREATE TABLE lots (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES items(id),
    lot_code text NOT NULL,
    status text NOT NULL,
    manufactured_at timestamptz,
    received_at timestamptz,
    expires_at timestamptz,
    vendor_lot_code text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE lots
    ADD CONSTRAINT chk_lots_status
        CHECK (status IN ('active','quarantine','blocked','consumed','expired'));
CREATE UNIQUE INDEX idx_lots_item_code ON lots(item_id, lot_code);
CREATE INDEX idx_lots_status ON lots(status);
```

### Migration 2 — `inventory_movement_lots`

```sql
CREATE TABLE inventory_movement_lots (
    id uuid PRIMARY KEY,
    inventory_movement_line_id uuid NOT NULL REFERENCES inventory_movement_lines(id) ON DELETE CASCADE,
    lot_id uuid NOT NULL REFERENCES lots(id),
    uom text NOT NULL,
    quantity_delta numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory_movement_lots
    ADD CONSTRAINT chk_inventory_movement_lots_qty CHECK (quantity_delta <> 0);
CREATE INDEX idx_inventory_movement_lots_lot ON inventory_movement_lots(lot_id);
CREATE INDEX idx_inventory_movement_lots_line ON inventory_movement_lots(inventory_movement_line_id);
```

### Migration 3 — Optional `work_order_lot_links`

```sql
CREATE TABLE work_order_lot_links (
    id uuid PRIMARY KEY,
    work_order_execution_id uuid NOT NULL REFERENCES work_order_executions(id) ON DELETE CASCADE,
    inventory_movement_lot_id uuid NOT NULL REFERENCES inventory_movement_lots(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_lot_links
    ADD CONSTRAINT chk_work_order_lot_links_role CHECK (role IN ('consume','produce'));
CREATE INDEX idx_work_order_lot_links_execution ON work_order_lot_links(work_order_execution_id);
CREATE INDEX idx_work_order_lot_links_lot ON work_order_lot_links(inventory_movement_lot_id);
```

### Migration 4 — Optional `shipment_lot_links`

```sql
CREATE TABLE shipment_lot_links (
    id uuid PRIMARY KEY,
    sales_order_shipment_id uuid NOT NULL REFERENCES sales_order_shipments(id) ON DELETE CASCADE,
    inventory_movement_lot_id uuid NOT NULL REFERENCES inventory_movement_lots(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipment_lot_links_shipment ON shipment_lot_links(sales_order_shipment_id);
CREATE INDEX idx_shipment_lot_links_lot ON shipment_lot_links(inventory_movement_lot_id);
```

### Migration 5 — `recall_cases`

```sql
CREATE TABLE recall_cases (
    id uuid PRIMARY KEY,
    recall_number text NOT NULL UNIQUE,
    status text NOT NULL,
    severity text,
    initiated_at timestamptz,
    closed_at timestamptz,
    summary text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE recall_cases
    ADD CONSTRAINT chk_recall_cases_status
        CHECK (status IN ('draft','active','closed','canceled'));
ALTER TABLE recall_cases
    ADD CONSTRAINT chk_recall_cases_severity
        CHECK (severity IS NULL OR severity IN ('low','medium','high','critical'));
CREATE INDEX idx_recall_cases_status ON recall_cases(status, initiated_at);
```

### Migration 6 — `recall_case_targets`

```sql
CREATE TABLE recall_case_targets (
    id uuid PRIMARY KEY,
    recall_case_id uuid NOT NULL REFERENCES recall_cases(id) ON DELETE CASCADE,
    target_type text NOT NULL,
    lot_id uuid REFERENCES lots(id),
    item_id uuid REFERENCES items(id),
    uom text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recall_case_targets
    ADD CONSTRAINT chk_recall_targets_type CHECK (target_type IN ('lot','item'));
CREATE UNIQUE INDEX idx_recall_targets_unique
    ON recall_case_targets(recall_case_id, target_type, lot_id, item_id, uom);
```

### Migration 7 — `recall_trace_runs`

```sql
CREATE TABLE recall_trace_runs (
    id uuid PRIMARY KEY,
    recall_case_id uuid NOT NULL REFERENCES recall_cases(id) ON DELETE CASCADE,
    as_of timestamptz NOT NULL,
    status text NOT NULL,
    notes text,
    computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recall_trace_runs
    ADD CONSTRAINT chk_recall_trace_status CHECK (status IN ('computed','superseded'));
CREATE INDEX idx_recall_trace_runs_case ON recall_trace_runs(recall_case_id, computed_at);
```

### Migration 8 — `recall_impacted_shipments`

```sql
CREATE TABLE recall_impacted_shipments (
    id uuid PRIMARY KEY,
    recall_trace_run_id uuid NOT NULL REFERENCES recall_trace_runs(id) ON DELETE CASCADE,
    sales_order_shipment_id uuid NOT NULL REFERENCES sales_order_shipments(id),
    customer_id uuid NOT NULL REFERENCES customers(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recall_trace_run_id, sales_order_shipment_id)
);
CREATE INDEX idx_recall_impacted_shipments_customer ON recall_impacted_shipments(customer_id);
```

### Migration 9 — Optional `recall_impacted_lots`

```sql
CREATE TABLE recall_impacted_lots (
    id uuid PRIMARY KEY,
    recall_trace_run_id uuid NOT NULL REFERENCES recall_trace_runs(id) ON DELETE CASCADE,
    lot_id uuid NOT NULL REFERENCES lots(id),
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recall_trace_run_id, lot_id, role)
);
ALTER TABLE recall_impacted_lots
    ADD CONSTRAINT chk_recall_impacted_lot_role
        CHECK (role IN ('target','upstream_component','downstream_finished'));
```

### Migration 10 — `recall_actions`

```sql
CREATE TABLE recall_actions (
    id uuid PRIMARY KEY,
    recall_case_id uuid NOT NULL REFERENCES recall_cases(id) ON DELETE CASCADE,
    action_type text NOT NULL,
    status text NOT NULL,
    lot_id uuid REFERENCES lots(id),
    sales_order_shipment_id uuid REFERENCES sales_order_shipments(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE recall_actions
    ADD CONSTRAINT chk_recall_actions_type
        CHECK (action_type IN ('block_lot','quarantine_lot','scrap_lot','restock_lot','customer_notify'));
ALTER TABLE recall_actions
    ADD CONSTRAINT chk_recall_actions_status
        CHECK (status IN ('planned','in_progress','completed','canceled'));
CREATE INDEX idx_recall_actions_case_status
    ON recall_actions(recall_case_id, status);
CREATE INDEX idx_recall_actions_lot ON recall_actions(lot_id);
```

### Migration 11 — `recall_communications`

```sql
CREATE TABLE recall_communications (
    id uuid PRIMARY KEY,
    recall_case_id uuid NOT NULL REFERENCES recall_cases(id) ON DELETE CASCADE,
    customer_id uuid REFERENCES customers(id),
    channel text NOT NULL,
    status text NOT NULL,
    sent_at timestamptz,
    subject text,
    body text,
    external_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recall_communications
    ADD CONSTRAINT chk_recall_communications_channel
        CHECK (channel IN ('email','phone','letter','portal'));
ALTER TABLE recall_communications
    ADD CONSTRAINT chk_recall_communications_status
        CHECK (status IN ('draft','sent','failed'));
CREATE INDEX idx_recall_communications_case ON recall_communications(recall_case_id, created_at);
CREATE INDEX idx_recall_communications_customer ON recall_communications(customer_id);
```

### Migration 12 — `kpi_runs`

```sql
CREATE TABLE kpi_runs (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    window_start timestamptz,
    window_end timestamptz,
    as_of timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kpi_runs
    ADD CONSTRAINT chk_kpi_runs_status
        CHECK (status IN ('draft','computed','published','archived'));
CREATE INDEX idx_kpi_runs_status ON kpi_runs(status, created_at);
```

### Migration 13 — `kpi_snapshots`

```sql
CREATE TABLE kpi_snapshots (
    id uuid PRIMARY KEY,
    kpi_run_id uuid NOT NULL REFERENCES kpi_runs(id) ON DELETE CASCADE,
    kpi_name text NOT NULL,
    dimensions jsonb NOT NULL,
    value numeric(18,6),
    units text,
    computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kpi_snapshots_run ON kpi_snapshots(kpi_run_id, kpi_name);
CREATE INDEX idx_kpi_snapshots_dimensions_gin ON kpi_snapshots USING gin(dimensions);
```

### Migration 14 — Optional `kpi_rollup_inputs`

```sql
CREATE TABLE kpi_rollup_inputs (
    id uuid PRIMARY KEY,
    kpi_run_id uuid NOT NULL REFERENCES kpi_runs(id) ON DELETE CASCADE,
    metric_name text NOT NULL,
    dimensions jsonb NOT NULL,
    numerator_qty numeric(18,6),
    denominator_qty numeric(18,6),
    computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kpi_rollup_inputs_run
    ON kpi_rollup_inputs(kpi_run_id, metric_name);
CREATE INDEX idx_kpi_rollup_inputs_dimensions_gin
    ON kpi_rollup_inputs USING gin(dimensions);
```

---

## Validations Remaining in the Service Layer

These invariants must be enforced outside the DB:

1. **Lot ↔ movement item consistency**
   - Ensuring `lots.item_id` matches the movement line’s `item_id` is service logic.

2. **Full lot allocation per movement line**
   - Application must verify the sum of lot quantities equals the movement line quantity (DB only stores rows).

3. **Trace graph traversal**
   - Forward/backward trace logic is runtime; DB only stores edges (movement lot links).

4. **KPI computation**
   - `kpi_snapshots` store results; computing turns/DOI/ILFR remains in service logic.

5. **Recall trace snapshots**
   - Service layer computes impacted sets and inserts rows; DB does not validate trace correctness.

6. **Recall action semantics**
   - Mapping action types to actual inventory movements and ensuring `occurred_at` within recall windows (policy) is application logic.

7. **Append-only behavior**
   - Application/service ensures new runs or trace snapshots are inserted rather than mutated.

This plan freezes the Phase 7 reporting/compliance schema ahead of any runtime implementation.***
