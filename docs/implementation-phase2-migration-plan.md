# Implementation Layer — Phase 2 Features 1–4

This document describes the **PostgreSQL migration plan** for Phase 2 features:

1. Feature 1 — Domain model clarifications (already covered in Phase 0; no new migrations)
2. Feature 2 — Receiving + QC extensions (already covered in Phase 1; no new migrations)
3. Feature 3 — Cycle counting
4. Feature 4 — Inventory accuracy metrics

For Phase 2 we focus on the new tables introduced by Features 3 and 4. Each step lists tables, indexes, DB-enforceable constraints, and validations that must remain in the service layer. Ordered migrations assume Phase 0–1 migrations are applied.

---

## Ordered Migration Plan

### Migration 1 — `cycle_counts`

```sql
CREATE TABLE cycle_counts (
    id uuid PRIMARY KEY,
    status text NOT NULL,
    counted_at timestamptz NOT NULL,
    location_id uuid NOT NULL REFERENCES locations(id),
    notes text,
    inventory_adjustment_id uuid REFERENCES inventory_adjustments(id),
    inventory_movement_id uuid REFERENCES inventory_movements(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
] -- updated_at is service-managed (no DB default); the application must set/update it on every insert/update.
ALTER TABLE cycle_counts
    ADD CONSTRAINT chk_cycle_counts_status
        CHECK (status IN ('draft','in_progress','posted','canceled'));
CREATE INDEX idx_cycle_counts_location ON cycle_counts(location_id, counted_at);
CREATE UNIQUE INDEX idx_cycle_counts_adjustment
    ON cycle_counts(inventory_adjustment_id)
    WHERE inventory_adjustment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_cycle_counts_movement
    ON cycle_counts(inventory_movement_id)
    WHERE inventory_movement_id IS NOT NULL;
```

### Migration 2 — `cycle_count_lines`

```sql
CREATE TABLE cycle_count_lines (
    id uuid PRIMARY KEY,
    cycle_count_id uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    counted_quantity numeric(18,6) NOT NULL,
    system_quantity numeric(18,6),
    variance_quantity numeric(18,6),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_count_id, line_number),
    UNIQUE (cycle_count_id, item_id, uom)
);
-- Optional: add index for cross-count reporting if needed later
-- CREATE INDEX idx_cycle_count_lines_item_uom ON cycle_count_lines(item_id, uom);

> Note: `updated_at` has no DB default; the service layer must set it on insert/update (same pattern as Phase 1 tables).
ALTER TABLE cycle_count_lines
    ADD CONSTRAINT chk_cycle_count_lines_counted_nonnegative
        CHECK (counted_quantity >= 0);
```

### Migration 3 — Optional `cycle_count_scopes`

```sql
CREATE TABLE cycle_count_scopes (
    id uuid PRIMARY KEY,
    cycle_count_id uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    uom text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_count_id, item_id, uom)
);
```

### Migration 4 — `service_metric_snapshots` (Phase 5 Feature 4 re-used for metrics)

Phase 2 Feature 4 does not introduce new tables beyond `cycle_counts` and `cycle_count_lines`. If you want to store accuracy metrics or snapshots separately, you can either:

- Use Phase 5 Feature 4 `service_metric_snapshots` once it exists, or
- Create a minimal table now (optional):

```sql
CREATE TABLE cycle_count_metrics (
    id uuid PRIMARY KEY,
    cycle_count_id uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
    computed_at timestamptz NOT NULL DEFAULT now(),
    total_lines integer NOT NULL,
    hits integer NOT NULL,
    hit_rate numeric(18,6) NOT NULL,
    total_abs_variance numeric(18,6) NOT NULL,
    total_system_qty numeric(18,6) NOT NULL,
    weighted_variance_pct numeric(18,6) NOT NULL,
    weighted_accuracy_pct numeric(18,6) NOT NULL,
    UNIQUE (cycle_count_id)
);

> Note: Phase 2 metric storage is independent from Phase 5 service metrics; do not conflate schemas.
```

---

## Validations Remaining in the Service Layer

The following rules cannot be enforced solely by PostgreSQL and must remain in application logic:

1. **Cycle count posting atomicity**
   - Ensuring `cycle_counts.status` transitions to `posted` atomically with creating the linked `inventory_adjustment` and `inventory_movement`.

2. **Line ↔ movement correspondence**
   - Enforcing that each `cycle_count_line` maps exactly to corresponding `inventory_movement_line` entries (matching item/location/uom) is a service-layer responsibility.

3. **Counted/system snapshot accuracy**
   - Populating `system_quantity` and `variance_quantity` is done at posting time; DB cannot enforce the snapshot values.

4. **Unique `(cycle_count_id, item_id, uom)` semantics**
   - Although enforced by a unique constraint, ensuring the policy “one line per item/uom per count” is followed when generating scopes/lines is an application concern (especially when partially counted).

5. **Deriving `hit_rate`, `weighted_accuracy_pct`**
   - Calculations and consistency between `cycle_count_lines` and metric snapshots must be handled in the service layer.

6. **Aggregation window selection**
   - Rolling up metrics to windows (weekly/monthly) or summing across counts is outside the DB schema.

This plan establishes the additional tables required for Phase 2 while documenting the invariants that must still be enforced in code or service workflows.
// Actually need to update by editing text; can't use SQL snippet for comment.
