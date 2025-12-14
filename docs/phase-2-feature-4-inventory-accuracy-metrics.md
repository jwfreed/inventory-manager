# Phase 2 — Feature 4: Inventory Accuracy Metrics (Variance %, Count Accuracy) — Schemas + Acceptance Criteria Only

This document defines **schemas (optional)** and **documented computations** for inventory accuracy metrics derived from cycle counts.
It is **documentation only** (no migrations, no jobs/materializations, no runtime implementation).

## Scope

Supports:
- Computing per-count and aggregate accuracy metrics from posted cycle counts (Phase 2 Feature 3).
- Defining reusable metric formulas (variance %, accuracy %).
- Optional storage of computed metric snapshots for reporting.

Out of scope:
- ABC classification / cycle count scheduling.
- SLA/alerts.
- BI/dashboard implementation.

## Metric Definitions (Documented)

All metrics are computed per `(item_id, location_id, uom)` and/or aggregated, and should use **posted** cycle counts only.

### Variance quantity

From Phase 2 Feature 3:
- `variance_qty = counted_quantity - system_quantity`

### Absolute variance quantity
- `abs_variance_qty = abs(variance_qty)`

### Variance percent

Define variance percent as absolute variance over system quantity, with safe handling for zero:
- If `system_quantity > 0`: `variance_pct = abs_variance_qty / system_quantity`
- If `system_quantity = 0`:
  - If `counted_quantity = 0`: `variance_pct = 0`
  - Else: `variance_pct = 1` (100% variance) as a Phase 2 convention

### Count accuracy percent

Define accuracy as 1 - variance percent:
- `accuracy_pct = 1 - variance_pct`

Clamp to `[0, 1]` if needed.

### Count “hit rate” (optional)

Binary accuracy indicator per line:
- `hit = (variance_qty = 0)`

Aggregate hit rate:
- `hit_rate = avg(hit)` across lines (or weighted by system quantity in later phases).

## Documented Aggregations

### Per cycle count (header-level)

For a posted `cycle_counts.id`:
- Metric source rule: when present, header-level metrics are computed from posting-time snapshots (`cycle_count_lines.system_quantity`, `cycle_count_lines.variance_quantity`). If snapshots are absent, metrics may be computed on demand from ledger-derived quantities, but implementations must not mix sources within the same metric run.
- `total_lines = count(lines)`
- `hits = count(lines where variance_qty = 0)`
- `hit_rate = hits / total_lines`
- `total_abs_variance = sum(abs_variance_qty)`
- `total_system_qty = sum(system_quantity)`
- `weighted_variance_pct = total_abs_variance / total_system_qty` (when total_system_qty > 0)
- `weighted_accuracy_pct = 1 - weighted_variance_pct`

If `total_system_qty = 0`, set `weighted_variance_pct` to `0` when all counted quantities are `0`, else `1` (mirroring the line-level convention), and compute `weighted_accuracy_pct = 1 - weighted_variance_pct`.

### Over time / location / item

Aggregate metrics across posted counts filtered by:
- `location_id`
- `item_id`
- date ranges on `counted_at`

Phase 2 does not define weighting policy beyond the header-level weighted example above; implementations must choose and document their reporting weight strategy.

## Optional Read-Model Schemas (Phase 2, Docs Only)

### `cycle_count_metrics` (optional)

Stores computed header-level metrics as a snapshot at posting time.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `cycle_count_id` | `uuid` | no | PK; FK → `cycle_counts(id)` |
| `computed_at` | `timestamptz` | no | default now() |
| `total_lines` | `integer` | no | |
| `hits` | `integer` | no | |
| `hit_rate` | `numeric(18,6)` | no | 0..1 |
| `total_abs_variance` | `numeric(18,6)` | no | |
| `total_system_qty` | `numeric(18,6)` | no | |
| `weighted_variance_pct` | `numeric(18,6)` | no | 0..1 |
| `weighted_accuracy_pct` | `numeric(18,6)` | no | 0..1 |

Constraints / indexes (if materialized later):
- `foreign key (cycle_count_id) references cycle_counts(id)`
- `check (hit_rate >= 0 and hit_rate <= 1)`
- `check (weighted_variance_pct >= 0 and weighted_variance_pct <= 1)`
- `check (weighted_accuracy_pct >= 0 and weighted_accuracy_pct <= 1)`

### `cycle_count_line_metrics` (optional)

Optional per-line metric snapshot (primarily for audit/reporting; not required for Phase 2).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `cycle_count_line_id` | `uuid` | no | PK; FK → `cycle_count_lines(id)` |
| `computed_at` | `timestamptz` | no | default now() |
| `variance_qty` | `numeric(18,6)` | no | |
| `abs_variance_qty` | `numeric(18,6)` | no | |
| `variance_pct` | `numeric(18,6)` | no | 0..1 |
| `accuracy_pct` | `numeric(18,6)` | no | 0..1 |
| `hit` | `boolean` | no | |

Constraints / indexes (if materialized later):
- `foreign key (cycle_count_line_id) references cycle_count_lines(id)`
- `check (variance_pct >= 0 and variance_pct <= 1)`
- `check (accuracy_pct >= 0 and accuracy_pct <= 1)`

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines variance %, accuracy %, and (optional) hit rate metrics with explicit formulas and zero-handling conventions.
2. Documentation defines how to aggregate metrics per cycle count and for reporting cuts (time/location/item).
3. Documentation specifies optional snapshot schemas (`cycle_count_metrics`, `cycle_count_line_metrics`) as docs-only with columns and constraints.
4. No production code is added (no migrations executed, no jobs/materializations, no runtime implementation).
