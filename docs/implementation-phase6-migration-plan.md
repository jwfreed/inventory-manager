# Implementation Layer — Phase 6 (Distribution Requirements Planning)

This document translates the Phase 6 DRP specification into an ordered PostgreSQL migration plan covering:

- DRP runs (planning horizon + bucket)
- DRP network modeling (nodes + lanes)
- Time-phased gross requirements & scheduled receipts at nodes
- DRP policy snapshots (item policies at nodes)
- Computed DRP plan lines (netting) and planned transfers

Scope: **database schema only**. No engines, jobs, or runtime logic.

Dependencies:
- Phase 0/2 base tables (items, locations, inventory_movements)
- Phase 3 BOM tables (used by Phase 5; not required here but assumed present)

---

## Ordered Migration Plan

### Migration 1 — `drp_nodes`

```sql
CREATE TABLE drp_nodes (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    location_id uuid NOT NULL REFERENCES locations(id),
    node_type text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE drp_nodes
    ADD CONSTRAINT chk_drp_nodes_type
        CHECK (node_type IN ('plant','dc','store'));
CREATE UNIQUE INDEX idx_drp_nodes_location
    ON drp_nodes(location_id);
CREATE INDEX idx_drp_nodes_type_active ON drp_nodes(node_type, active);
```

### Migration 2 — `drp_lanes`

```sql
CREATE TABLE drp_lanes (
    id uuid PRIMARY KEY,
    from_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    transfer_lead_time_days integer NOT NULL,
    active boolean NOT NULL DEFAULT true,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE drp_lanes
    ADD CONSTRAINT chk_drp_lanes_nodes CHECK (from_node_id <> to_node_id);
ALTER TABLE drp_lanes
    ADD CONSTRAINT chk_drp_lanes_lead_time CHECK (transfer_lead_time_days >= 0);
CREATE UNIQUE INDEX idx_drp_lanes_pair
    ON drp_lanes(from_node_id, to_node_id);
CREATE INDEX idx_drp_lanes_to_node ON drp_lanes(to_node_id, active);
```

### Migration 3 — `drp_runs`

```sql
CREATE TABLE drp_runs (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    bucket_type text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    as_of timestamptz NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drp_runs
    ADD CONSTRAINT chk_drp_runs_status
        CHECK (status IN ('draft','computed','published','archived'));
ALTER TABLE drp_runs
    ADD CONSTRAINT chk_drp_runs_bucket_type
        CHECK (bucket_type IN ('day','week','month'));
ALTER TABLE drp_runs
    ADD CONSTRAINT chk_drp_runs_date_range CHECK (starts_on <= ends_on);
CREATE INDEX idx_drp_runs_status ON drp_runs(status);
CREATE INDEX idx_drp_runs_window ON drp_runs(starts_on, ends_on);
```

### Migration 4 — `drp_item_policies`

```sql
CREATE TABLE drp_item_policies (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    preferred_from_node_id uuid REFERENCES drp_nodes(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    safety_stock_qty numeric(18,6),
    lot_sizing_method text NOT NULL,
    foq_qty numeric(18,6),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (drp_run_id, to_node_id, item_id, uom)
);
ALTER TABLE drp_item_policies
    ADD CONSTRAINT chk_drp_item_policies
        CHECK (
            (safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND
            lot_sizing_method IN ('l4l','foq') AND
            (lot_sizing_method <> 'foq' OR foq_qty > 0)
        );
CREATE INDEX idx_drp_item_policies_run_node
    ON drp_item_policies(drp_run_id, to_node_id);
```

### Migration 5 — `drp_periods` (optional)

```sql
CREATE TABLE drp_periods (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    period_start date NOT NULL,
    period_end date NOT NULL,
    sequence integer NOT NULL,
    UNIQUE (drp_run_id, sequence),
    UNIQUE (drp_run_id, period_start, period_end)
);
ALTER TABLE drp_periods
    ADD CONSTRAINT chk_drp_period_dates CHECK (period_start <= period_end);
CREATE INDEX idx_drp_periods_run ON drp_periods(drp_run_id, period_start);
```

### Migration 6 — `drp_gross_requirements`

```sql
CREATE TABLE drp_gross_requirements (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    period_start date NOT NULL,
    source_type text NOT NULL,
    source_ref text,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drp_gross_requirements
    ADD CONSTRAINT chk_drp_gross_req_type
        CHECK (source_type IN ('forecast','sales_orders','dependent'));
ALTER TABLE drp_gross_requirements
    ADD CONSTRAINT chk_drp_gross_req_quantity CHECK (quantity >= 0);
CREATE INDEX idx_drp_gross_req_run_node_item_period
    ON drp_gross_requirements(drp_run_id, to_node_id, item_id, period_start);
```

### Migration 7 — `drp_scheduled_receipts` (optional)

```sql
CREATE TABLE drp_scheduled_receipts (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    period_start date NOT NULL,
    source_type text NOT NULL,
    source_ref text,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drp_scheduled_receipts
    ADD CONSTRAINT chk_drp_sched_receipts_type
        CHECK (source_type IN ('planned_transfers','purchase_orders','work_orders'));
ALTER TABLE drp_scheduled_receipts
    ADD CONSTRAINT chk_drp_sched_receipts_quantity CHECK (quantity >= 0);
CREATE INDEX idx_drp_sched_receipts_run_node_item_period
    ON drp_scheduled_receipts(drp_run_id, to_node_id, item_id, period_start);
```

### Migration 8 — `drp_plan_lines`

```sql
CREATE TABLE drp_plan_lines (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    period_start date NOT NULL,
    begin_on_hand_qty numeric(18,6),
    gross_requirements_qty numeric(18,6),
    scheduled_receipts_qty numeric(18,6),
    net_requirements_qty numeric(18,6),
    planned_transfer_receipt_qty numeric(18,6),
    planned_transfer_release_qty numeric(18,6),
    projected_end_on_hand_qty numeric(18,6),
    computed_at timestamptz,
    UNIQUE (drp_run_id, to_node_id, item_id, uom, period_start)
);
CREATE INDEX idx_drp_plan_lines_run_period
    ON drp_plan_lines(drp_run_id, period_start);
```

### Migration 9 — `drp_planned_transfers`

```sql
CREATE TABLE drp_planned_transfers (
    id uuid PRIMARY KEY,
    drp_run_id uuid NOT NULL REFERENCES drp_runs(id) ON DELETE CASCADE,
    from_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    to_node_id uuid NOT NULL REFERENCES drp_nodes(id),
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    release_date date NOT NULL,
    receipt_date date NOT NULL,
    lane_id uuid REFERENCES drp_lanes(id),
    source_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drp_planned_transfers
    ADD CONSTRAINT chk_drp_planned_transfers_nodes CHECK (from_node_id <> to_node_id);
ALTER TABLE drp_planned_transfers
    ADD CONSTRAINT chk_drp_planned_transfers_quantity CHECK (quantity > 0);
ALTER TABLE drp_planned_transfers
    ADD CONSTRAINT chk_drp_planned_transfers_dates CHECK (release_date <= receipt_date);
CREATE INDEX idx_drp_planned_transfers_run_release
    ON drp_planned_transfers(drp_run_id, release_date);
```

---

## Validations Remaining in the Service Layer

These invariants remain outside the database:

1. **Period coverage and overlap checks**
   - Ensuring `drp_runs` period buckets cover the horizon without gaps/overlaps.

2. **Lane selection determinism**
   - Resolving source lane when `preferred_from_node_id` is NULL (Phase 7 doc clarifies tie-breaking).

3. **Lead-time offsets**
   - Converting days → period offsets (ceil/floor policy) is handled in the planning engine.

4. **Source feasibility**
   - Checking if the source node has on-hand to satisfy planned transfers is an application concern (Phase 7 default allows publishing with exceptions).

5. **Traceability to BOM/DRP inputs**
   - Ensuring dependent demand is off by default and only enabled under explicit policy.

6. **UOM consistency across nodes**
   - Enforcing consistent UOM in planning data is part of service-layer validation.

This plan captures the Phase 6 schema needed for DRP planning without introducing runtime logic or engines.***
