# Implementation Layer — Phase 5 (Features 1–4)

This document translates the Phase 5 planning/reporting specs into an ordered PostgreSQL migration plan covering:

1. MPS (Master Production Schedule)
2. MRP Explosion
3. Replenishment policies
4. Service metrics (PPIS/ILFR snapshots)

Design goals:
- Planning tables are read models; they do **not** supersede the movement ledger.
- Capture required tables, indexes, and DB-enforceable constraints.
- Document which validations stay in the service layer (e.g., BOM resolution, lot-sizing decisions).

Dependencies:
- Phase 0/2 base tables (items, locations, inventory movements, audit).
- Phase 3 BOM definitions (for MRP explosion).
- Phase 4 documents (sales orders/shipments/reservations) feed some metrics.

---

## Ordered Migration Plan

### Migration 1 — `mps_plans`

```sql
CREATE TABLE mps_plans (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    status text NOT NULL,
    bucket_type text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE mps_plans
    ADD CONSTRAINT chk_mps_plans_status
        CHECK (status IN ('draft','published','archived'));
ALTER TABLE mps_plans
    ADD CONSTRAINT chk_mps_bucket_type
        CHECK (bucket_type IN ('day','week','month'));
ALTER TABLE mps_plans
    ADD CONSTRAINT chk_mps_date_range CHECK (starts_on <= ends_on);
CREATE INDEX idx_mps_plans_status ON mps_plans(status);
CREATE INDEX idx_mps_plans_window ON mps_plans(starts_on, ends_on);
```

### Migration 2 — `mps_plan_items`

```sql
CREATE TABLE mps_plan_items (
    id uuid PRIMARY KEY,
    mps_plan_id uuid NOT NULL REFERENCES mps_plans(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    safety_stock_qty numeric(18,6),
    lot_size_qty numeric(18,6),
    lead_time_days integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mps_plan_id, item_id, uom, site_location_id)
);
ALTER TABLE mps_plan_items
    ADD CONSTRAINT chk_mps_plan_items_qtys CHECK (
        (safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND
        (lot_size_qty IS NULL OR lot_size_qty > 0) AND
        (lead_time_days IS NULL OR lead_time_days >= 0)
    );
CREATE INDEX idx_mps_plan_items_plan ON mps_plan_items(mps_plan_id);
CREATE INDEX idx_mps_plan_items_item ON mps_plan_items(item_id);
```

### Migration 3 — `mps_periods`

```sql
CREATE TABLE mps_periods (
    id uuid PRIMARY KEY,
    mps_plan_id uuid NOT NULL REFERENCES mps_plans(id) ON DELETE CASCADE,
    period_start date NOT NULL,
    period_end date NOT NULL,
    sequence integer NOT NULL,
    UNIQUE (mps_plan_id, sequence),
    UNIQUE (mps_plan_id, period_start, period_end)
);
ALTER TABLE mps_periods
    ADD CONSTRAINT chk_mps_period_dates CHECK (period_start <= period_end);
CREATE INDEX idx_mps_periods_plan ON mps_periods(mps_plan_id, period_start);
```

### Migration 4 — `mps_demand_inputs`

```sql
CREATE TABLE mps_demand_inputs (
    id uuid PRIMARY KEY,
    mps_plan_item_id uuid NOT NULL REFERENCES mps_plan_items(id) ON DELETE CASCADE,
    mps_period_id uuid NOT NULL REFERENCES mps_periods(id) ON DELETE CASCADE,
    demand_type text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mps_plan_item_id, mps_period_id, demand_type)
);
ALTER TABLE mps_demand_inputs
    ADD CONSTRAINT chk_mps_demand_type CHECK (demand_type IN ('forecast','sales_orders'));
ALTER TABLE mps_demand_inputs
    ADD CONSTRAINT chk_mps_demand_quantity CHECK (quantity >= 0);
CREATE INDEX idx_mps_demand_inputs_period ON mps_demand_inputs(mps_period_id);
```

### Migration 5 — `mps_supply_inputs` (optional)

```sql
CREATE TABLE mps_supply_inputs (
    id uuid PRIMARY KEY,
    mps_plan_item_id uuid NOT NULL REFERENCES mps_plan_items(id) ON DELETE CASCADE,
    mps_period_id uuid NOT NULL REFERENCES mps_periods(id) ON DELETE CASCADE,
    supply_type text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mps_plan_item_id, mps_period_id, supply_type)
);
ALTER TABLE mps_supply_inputs
    ADD CONSTRAINT chk_mps_supply_type CHECK (supply_type IN ('work_orders'));
ALTER TABLE mps_supply_inputs
    ADD CONSTRAINT chk_mps_supply_quantity CHECK (quantity >= 0);
```

### Migration 6 — `mps_plan_lines`

```sql
CREATE TABLE mps_plan_lines (
    id uuid PRIMARY KEY,
    mps_plan_item_id uuid NOT NULL REFERENCES mps_plan_items(id) ON DELETE CASCADE,
    mps_period_id uuid NOT NULL REFERENCES mps_periods(id) ON DELETE CASCADE,
    begin_on_hand_qty numeric(18,6),
    demand_qty numeric(18,6),
    scheduled_receipts_qty numeric(18,6),
    net_requirements_qty numeric(18,6),
    planned_production_qty numeric(18,6),
    projected_end_on_hand_qty numeric(18,6),
    computed_at timestamptz,
    UNIQUE (mps_plan_item_id, mps_period_id)
);
CREATE INDEX idx_mps_plan_lines_period ON mps_plan_lines(mps_period_id);
```

### Migration 7 — `mrp_runs`

```sql
CREATE TABLE mrp_runs (
    id uuid PRIMARY KEY,
    mps_plan_id uuid NOT NULL REFERENCES mps_plans(id),
    status text NOT NULL,
    as_of timestamptz NOT NULL,
    bucket_type text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mrp_runs
    ADD CONSTRAINT chk_mrp_runs_status
        CHECK (status IN ('draft','computed','published','archived'));
ALTER TABLE mrp_runs
    ADD CONSTRAINT chk_mrp_runs_bucket_type
        CHECK (bucket_type IN ('day','week','month'));
CREATE INDEX idx_mrp_runs_mps ON mrp_runs(mps_plan_id);
```

### Migration 8 — `mrp_item_policies`

```sql
CREATE TABLE mrp_item_policies (
    id uuid PRIMARY KEY,
    mrp_run_id uuid NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    planning_lead_time_days integer,
    safety_stock_qty numeric(18,6),
    lot_sizing_method text NOT NULL,
    foq_qty numeric(18,6),
    poq_periods integer,
    ppb_periods integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mrp_run_id, item_id, uom, site_location_id)
);
ALTER TABLE mrp_item_policies
    ADD CONSTRAINT chk_mrp_item_policies
        CHECK (
            (planning_lead_time_days IS NULL OR planning_lead_time_days >= 0) AND
            (safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND
            lot_sizing_method IN ('l4l','foq','poq','ppb') AND
            (lot_sizing_method <> 'foq' OR foq_qty > 0) AND
            (lot_sizing_method <> 'poq' OR poq_periods > 0) AND
            (lot_sizing_method <> 'ppb' OR ppb_periods > 0)
        );
```

### Migration 9 — `mrp_gross_requirements`

```sql
CREATE TABLE mrp_gross_requirements (
    id uuid PRIMARY KEY,
    mrp_run_id uuid NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    period_start date NOT NULL,
    source_type text NOT NULL,
    source_ref text,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mrp_gross_requirements
    ADD CONSTRAINT chk_mrp_gross_req_type
        CHECK (source_type IN ('mps','bom_explosion'));
ALTER TABLE mrp_gross_requirements
    ADD CONSTRAINT chk_mrp_gross_req_quantity CHECK (quantity >= 0);
CREATE INDEX idx_mrp_gross_req_run_item_period
    ON mrp_gross_requirements(mrp_run_id, item_id, period_start);
```

### Migration 10 — `mrp_scheduled_receipts` (optional)

```sql
CREATE TABLE mrp_scheduled_receipts (
    id uuid PRIMARY KEY,
    mrp_run_id uuid NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    period_start date NOT NULL,
    source_type text NOT NULL,
    source_ref text,
    quantity numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mrp_scheduled_receipts
    ADD CONSTRAINT chk_mrp_sched_receipts_type
        CHECK (source_type IN ('purchase_orders','work_orders','planned_transfers'));
ALTER TABLE mrp_scheduled_receipts
    ADD CONSTRAINT chk_mrp_sched_receipts_quantity CHECK (quantity >= 0);
CREATE INDEX idx_mrp_sched_receipts_run_item_period
    ON mrp_scheduled_receipts(mrp_run_id, item_id, period_start);
```

### Migration 11 — `mrp_plan_lines`

```sql
CREATE TABLE mrp_plan_lines (
    id uuid PRIMARY KEY,
    mrp_run_id uuid NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    period_start date NOT NULL,
    begin_on_hand_qty numeric(18,6),
    gross_requirements_qty numeric(18,6),
    scheduled_receipts_qty numeric(18,6),
    net_requirements_qty numeric(18,6),
    planned_order_receipt_qty numeric(18,6),
    planned_order_release_qty numeric(18,6),
    projected_end_on_hand_qty numeric(18,6),
    computed_at timestamptz,
    UNIQUE (mrp_run_id, item_id, uom, site_location_id, period_start)
);
CREATE INDEX idx_mrp_plan_lines_run_period ON mrp_plan_lines(mrp_run_id, period_start);
```

### Migration 12 — `mrp_planned_orders`

```sql
CREATE TABLE mrp_planned_orders (
    id uuid PRIMARY KEY,
    mrp_run_id uuid NOT NULL REFERENCES mrp_runs(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    order_type text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    release_date date NOT NULL,
    receipt_date date NOT NULL,
    source_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mrp_planned_orders
    ADD CONSTRAINT chk_mrp_planned_orders_type
        CHECK (order_type IN ('planned_work_order','planned_purchase_order'));
ALTER TABLE mrp_planned_orders
    ADD CONSTRAINT chk_mrp_planned_orders_quantity CHECK (quantity > 0);
ALTER TABLE mrp_planned_orders
    ADD CONSTRAINT chk_mrp_planned_orders_dates CHECK (release_date <= receipt_date);
CREATE INDEX idx_mrp_planned_orders_run_release
    ON mrp_planned_orders(mrp_run_id, release_date);
```

### Migration 13 — `replenishment_policies`

```sql
CREATE TABLE replenishment_policies (
    id uuid PRIMARY KEY,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    site_location_id uuid REFERENCES locations(id),
    policy_type text NOT NULL,
    status text NOT NULL,
    lead_time_days integer,
    demand_rate_per_day numeric(18,6),
    safety_stock_method text NOT NULL,
    safety_stock_qty numeric(18,6),
    ppis_periods integer,
    review_period_days integer,
    order_up_to_level_qty numeric(18,6),
    reorder_point_qty numeric(18,6),
    order_quantity_qty numeric(18,6),
    min_order_qty numeric(18,6),
    max_order_qty numeric(18,6),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    UNIQUE (item_id, uom, site_location_id)
);
ALTER TABLE replenishment_policies
    ADD CONSTRAINT chk_replenishment_policy_type
        CHECK (policy_type IN ('q_rop','t_oul'));
ALTER TABLE replenishment_policies
    ADD CONSTRAINT chk_replenishment_policy_status
        CHECK (status IN ('active','inactive'));
ALTER TABLE replenishment_policies
    ADD CONSTRAINT chk_replenishment_policy_safety_method
        CHECK (safety_stock_method IN ('none','fixed','ppis'));
ALTER TABLE replenishment_policies
    ADD CONSTRAINT chk_replenishment_policy_numbers
        CHECK (
            (lead_time_days IS NULL OR lead_time_days >= 0) AND
            (demand_rate_per_day IS NULL OR demand_rate_per_day >= 0) AND
            (safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND
            (ppis_periods IS NULL OR ppis_periods > 0) AND
            (review_period_days IS NULL OR review_period_days > 0) AND
            (order_up_to_level_qty IS NULL OR order_up_to_level_qty >= 0) AND
            (reorder_point_qty IS NULL OR reorder_point_qty >= 0) AND
            (order_quantity_qty IS NULL OR order_quantity_qty > 0) AND
            (min_order_qty IS NULL OR min_order_qty >= 0) AND
            (max_order_qty IS NULL OR max_order_qty >= 0)
        );
CREATE INDEX idx_replenishment_policies_status ON replenishment_policies(status);
```

### Migration 14 — Optional `replenishment_recommendations`

```sql
CREATE TABLE replenishment_recommendations (
    id uuid PRIMARY KEY,
    replenishment_policy_id uuid NOT NULL REFERENCES replenishment_policies(id) ON DELETE CASCADE,
    as_of timestamptz NOT NULL,
    on_hand_qty numeric(18,6) NOT NULL,
    on_order_qty numeric(18,6),
    reserved_qty numeric(18,6),
    effective_available_qty numeric(18,6) NOT NULL,
    safety_stock_qty numeric(18,6) NOT NULL,
    recommended_order_qty numeric(18,6) NOT NULL,
    policy_type text NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (replenishment_policy_id, as_of)
);
```

### Migration 15 — `kpi_runs`

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

### Migration 16 — `kpi_snapshots`

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

### Migration 17 — Optional `kpi_rollup_inputs`

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

The following invariants must be enforced outside the DB:

1. **Period generation / coverage**
   - Ensuring `mps_periods` fully cover the plan horizon with non-overlapping buckets.
   - Same for `mrp_runs` and DRP runs (Phase 6).

2. **Plan publishing immutability**
   - `mps_plans.status` and `mrp_runs.status` transitions must freeze inputs; DB cannot enforce cross-table immutability.

3. **BOM resolution / netting correctness**
   - Selecting the correct BOM version per receipt period and rejecting overlaps is service logic (Phase 3 dependency).

4. **Aggregation math (on-hand averages, outflow totals)**
   - `begin_on_hand_qty`, `demand_qty`, etc., must be populated by planning computations; DB cannot validate accuracy.

5. **Lot-sizing and lead-time conversions**
   - Converting days → buckets (ceil/floor rule) and applying lot-sizing (L4L/FOQ/POQ/PPB) is handled in planning engines.

6. **Replenishment policy enforcement**
   - Determining when to trigger orders, how to handle negative on-hand, and how to apply min/max order qty stays in service logic.

7. **Service metric calculations**
   - `kpi_snapshots` store values; correctness depends on upstream computations (PPIS, ILFR). DB just stores the results.

This plan locks down the Phase 5 schema slices needed before any planning/BI code is written.***
