# Implementation Layer — Phase 3 Features 1–4

This document describes the **PostgreSQL migration plan** for Phase 3 features:

1. Feature 1 — BOM / Recipes
2. Feature 2 — Work orders (+ execution docs)
3. Feature 3 — Material issue vs backflush policy
4. Feature 4 — WIP tracking

Each section lists tables, indexes, DB-enforceable constraints, and validations that must remain in the service layer. Ordered migrations assume Phase 0–2 migrations are already applied.

---

## Ordered Migration Plan

### Migration 1 — `boms`

```sql
CREATE TABLE boms (
    id uuid PRIMARY KEY,
    bom_code text NOT NULL UNIQUE,
    output_item_id uuid NOT NULL REFERENCES items(id),
    default_uom text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_boms_output_item ON boms(output_item_id);
CREATE INDEX idx_boms_active ON boms(active);
```

### Migration 2 — `bom_versions`

```sql
CREATE TABLE bom_versions (
    id uuid PRIMARY KEY,
    bom_id uuid NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    status text NOT NULL,
    effective_from timestamptz,
    effective_to timestamptz,
    yield_quantity numeric(18,6) NOT NULL,
    yield_uom text NOT NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL,
    UNIQUE (bom_id, version_number)
);
ALTER TABLE bom_versions
    ADD CONSTRAINT chk_bom_versions_status
        CHECK (status IN ('draft','active','retired'));
ALTER TABLE bom_versions
    ADD CONSTRAINT chk_bom_versions_yield_positive CHECK (yield_quantity > 0);
CREATE INDEX idx_bom_versions_bom_status ON bom_versions(bom_id, status);
CREATE INDEX idx_bom_versions_effective ON bom_versions(effective_from, effective_to);
```

### Migration 3 — `bom_version_lines`

```sql
CREATE TABLE bom_version_lines (
    id uuid PRIMARY KEY,
    bom_version_id uuid NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    component_item_id uuid NOT NULL REFERENCES items(id),
    component_quantity numeric(18,6) NOT NULL,
    component_uom text NOT NULL,
    scrap_factor numeric(18,6),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bom_version_id, line_number)
);
ALTER TABLE bom_version_lines
    ADD CONSTRAINT chk_bom_lines_qty_positive CHECK (component_quantity > 0);
CREATE INDEX idx_bom_lines_version ON bom_version_lines(bom_version_id);
CREATE INDEX idx_bom_lines_component_item ON bom_version_lines(component_item_id);
```

### Migration 4 — `work_orders`

```sql
CREATE TABLE work_orders (
    id uuid PRIMARY KEY,
    work_order_number text NOT NULL UNIQUE,
    status text NOT NULL,
    bom_id uuid NOT NULL REFERENCES boms(id),
    bom_version_id uuid REFERENCES bom_versions(id),
    output_item_id uuid NOT NULL REFERENCES items(id),
    output_uom text NOT NULL,
    quantity_planned numeric(18,6) NOT NULL,
    quantity_completed numeric(18,6),
    scheduled_start_at timestamptz,
    scheduled_due_at timestamptz,
    released_at timestamptz,
    completed_at timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE work_orders
    ADD CONSTRAINT chk_work_orders_status
        CHECK (status IN ('draft','released','in_progress','completed','canceled'));
ALTER TABLE work_orders
    ADD CONSTRAINT chk_work_orders_qty_planned CHECK (quantity_planned > 0);
ALTER TABLE work_orders
    ADD CONSTRAINT chk_work_orders_qty_completed_nonneg CHECK (quantity_completed IS NULL OR quantity_completed >= 0);
CREATE INDEX idx_work_orders_status ON work_orders(status);
CREATE INDEX idx_work_orders_bom_version ON work_orders(bom_id, bom_version_id);
```

### Migration 5 — `work_order_material_requirements`

```sql
CREATE TABLE work_order_material_requirements (
    id uuid PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    component_item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_required numeric(18,6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (work_order_id, line_number)
);
ALTER TABLE work_order_material_requirements
    ADD CONSTRAINT chk_womr_quantity_positive CHECK (quantity_required > 0);
CREATE INDEX idx_womr_work_order ON work_order_material_requirements(work_order_id);
CREATE INDEX idx_womr_component_item ON work_order_material_requirements(component_item_id);
```

### Migration 6 — `work_order_executions`

```sql
CREATE TABLE work_order_executions (
    id uuid PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES work_orders(id),
    occurred_at timestamptz NOT NULL,
    status text NOT NULL,
    consumption_movement_id uuid REFERENCES inventory_movements(id),
    production_movement_id uuid REFERENCES inventory_movements(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_executions
    ADD CONSTRAINT chk_work_order_executions_status
        CHECK (status IN ('draft','posted','canceled'));
CREATE INDEX idx_work_order_executions_work_order
    ON work_order_executions(work_order_id, occurred_at);
CREATE UNIQUE INDEX idx_work_order_executions_consumption
    ON work_order_executions(consumption_movement_id)
    WHERE consumption_movement_id IS NOT NULL;
CREATE UNIQUE INDEX idx_work_order_executions_production
    ON work_order_executions(production_movement_id)
    WHERE production_movement_id IS NOT NULL;
```

### Migration 7 — `work_order_execution_lines`

```sql
CREATE TABLE work_order_execution_lines (
    id uuid PRIMARY KEY,
    work_order_execution_id uuid NOT NULL REFERENCES work_order_executions(id) ON DELETE CASCADE,
    line_type text NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity numeric(18,6) NOT NULL,
    from_location_id uuid REFERENCES locations(id),
    to_location_id uuid REFERENCES locations(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_execution_lines
    ADD CONSTRAINT chk_wo_exec_lines_locations
        CHECK (
            (line_type = 'consume' AND from_location_id IS NOT NULL AND to_location_id IS NULL)
            OR (line_type = 'produce' AND to_location_id IS NOT NULL AND from_location_id IS NULL)
        );
-- Optional indexes for reporting/lookup:
-- CREATE INDEX idx_wo_exec_lines_from_location ON work_order_execution_lines(from_location_id);
-- CREATE INDEX idx_wo_exec_lines_to_location ON work_order_execution_lines(to_location_id);
ALTER TABLE work_order_execution_lines
    ADD CONSTRAINT chk_wo_exec_lines_type CHECK (line_type IN ('consume','produce'));
ALTER TABLE work_order_execution_lines
    ADD CONSTRAINT chk_wo_exec_lines_quantity CHECK (quantity > 0);
CREATE INDEX idx_wo_exec_lines_execution ON work_order_execution_lines(work_order_execution_id);
CREATE INDEX idx_wo_exec_lines_item ON work_order_execution_lines(item_id);
```

### Migration 8 — `work_order_material_issues`

```sql
CREATE TABLE work_order_material_issues (
    id uuid PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES work_orders(id),
    status text NOT NULL,
    occurred_at timestamptz NOT NULL,
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
ALTER TABLE work_order_material_issues
    ADD CONSTRAINT chk_womi_status CHECK (status IN ('draft','posted','canceled'));
CREATE UNIQUE INDEX idx_womi_movement
    ON work_order_material_issues(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
CREATE INDEX idx_womi_work_order ON work_order_material_issues(work_order_id, occurred_at);
```

### Migration 9 — `work_order_material_issue_lines`

```sql
CREATE TABLE work_order_material_issue_lines (
    id uuid PRIMARY KEY,
    work_order_material_issue_id uuid NOT NULL REFERENCES work_order_material_issues(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    component_item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_issued numeric(18,6) NOT NULL,
    from_location_id uuid NOT NULL REFERENCES locations(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (work_order_material_issue_id, line_number)
);
ALTER TABLE work_order_material_issue_lines
    ADD CONSTRAINT chk_womi_lines_quantity CHECK (quantity_issued > 0);
CREATE INDEX idx_womi_lines_issue_id ON work_order_material_issue_lines(work_order_material_issue_id);
CREATE INDEX idx_womi_lines_component_item ON work_order_material_issue_lines(component_item_id);
```

### Migration 10 — `work_order_backflush_events`

```sql
CREATE TABLE work_order_backflush_events (
    id uuid PRIMARY KEY,
    work_order_execution_id uuid NOT NULL REFERENCES work_order_executions(id) ON DELETE CASCADE,
    status text NOT NULL,
    occurred_at timestamptz NOT NULL,
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_backflush_events
    ADD CONSTRAINT chk_wobf_status CHECK (status IN ('draft','posted','canceled'));
CREATE UNIQUE INDEX idx_wobf_execution
    ON work_order_backflush_events(work_order_execution_id);
CREATE UNIQUE INDEX idx_wobf_movement
    ON work_order_backflush_events(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
```

### Migration 11 — `work_order_backflush_lines`

```sql
CREATE TABLE work_order_backflush_lines (
    id uuid PRIMARY KEY,
    work_order_backflush_event_id uuid NOT NULL REFERENCES work_order_backflush_events(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    component_item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_to_consume numeric(18,6) NOT NULL,
    from_location_id uuid REFERENCES locations(id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (work_order_backflush_event_id, line_number)
);
ALTER TABLE work_order_backflush_lines
    ADD CONSTRAINT chk_wobf_lines_quantity CHECK (quantity_to_consume > 0);
CREATE INDEX idx_wobf_lines_event ON work_order_backflush_lines(work_order_backflush_event_id);
CREATE INDEX idx_wobf_lines_component_item ON work_order_backflush_lines(component_item_id);
```

### Migration 12 — `work_orders` WIP columns

```sql
ALTER TABLE work_orders
    ADD COLUMN wip_tracking_mode text NOT NULL DEFAULT 'none',
    ADD COLUMN wip_location_id uuid REFERENCES locations(id);
ALTER TABLE work_orders
    ADD CONSTRAINT chk_work_orders_wip_mode
        CHECK (wip_tracking_mode IN ('none','location_based'));
CREATE INDEX idx_work_orders_wip_location ON work_orders(wip_location_id);
```

### Migration 13 — `work_order_wip_events`

```sql
CREATE TABLE work_order_wip_events (
    id uuid PRIMARY KEY,
    work_order_execution_id uuid NOT NULL REFERENCES work_order_executions(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    inventory_movement_id uuid NOT NULL REFERENCES inventory_movements(id),
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_wip_events
    ADD CONSTRAINT chk_wip_events_type CHECK (event_type IN ('move_into_wip','move_out_of_wip'));
CREATE UNIQUE INDEX idx_wip_events_movement
    ON work_order_wip_events(inventory_movement_id);
CREATE INDEX idx_wip_events_execution ON work_order_wip_events(work_order_execution_id, occurred_at);
```

### Migration 14 — `work_order_wip_event_lines`

```sql
CREATE TABLE work_order_wip_event_lines (
    id uuid PRIMARY KEY,
    work_order_wip_event_id uuid NOT NULL REFERENCES work_order_wip_events(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    quantity_delta numeric(18,6) NOT NULL,
    wip_location_id uuid NOT NULL REFERENCES locations(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (work_order_wip_event_id, line_number)
);
ALTER TABLE work_order_wip_event_lines
    ADD CONSTRAINT chk_wip_line_quantity_nonzero CHECK (quantity_delta <> 0);
CREATE INDEX idx_wip_event_lines_item ON work_order_wip_event_lines(item_id, wip_location_id);
```

---

## Validations Remaining in the Service Layer

The following rules cannot be enforced solely by PostgreSQL and must remain in application logic:

1. **BOM version selection**
   - Resolving the active/effective BOM version for an as-of date (while preventing overlaps/cycles) is handled in service logic.

2. **Work order lifecycle**
   - Enforcing state transitions (`draft → released → in_progress → completed`) and locking BOM version at release is application logic.

3. **Execution & movement linkage**
   - Ensuring `work_order_executions` transitions to `posted` atomically with posting their linked movements.
   - Enforcing that execution lines correspond exactly to movement lines (quantities, locations, signs).

4. **Material issue/backflush policy**
   - Enforcing policy rules (manual issue vs backflush; double-consumption prevention) is handled outside DB constraints.

5. **Putaway/completion cross-checks**
   - Already noted in previous phases; still service-layer logic.

6. **WIP location consistency**
   - Ensuring all WIP event lines use the work order’s `wip_location_id` and that WIP events exist only when tracking mode is `location_based`.

7. **Lot-level traceability**
   - When lots are eventually linked to work orders, cross-table validations remain service-layer responsibilities (not part of Phase 3 schema but relevant to future phases).

This plan freezes the Phase 3 schema decisions and highlights the enforcement boundaries between PostgreSQL constraints and application logic.
