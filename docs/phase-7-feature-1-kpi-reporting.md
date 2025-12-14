# Phase 7 — Feature 1: KPI / Reporting (Turns, DOI, C2C, Variance, PPIS/ILFR Rollups) — Schemas + Computations + Acceptance Criteria Only

This document defines **KPI/reporting schemas** and **documented computations** for common inventory and service KPIs:
- Inventory turns
- DOI (Days of Inventory)
- C2C (Cash-to-Cash) (definition + placeholder computation boundaries)
- Inventory accuracy variance rollups
- PPIS / ILFR rollups

It is **documentation only** (no migrations, no ETL/jobs, no runtime implementation).

## Scope

Supports:
- Defining KPI formulas and dimensionality.
- Computing KPIs from authoritative sources in earlier phases (ledger, sales docs, cycle counts, service metrics).
- Optional storage of KPI snapshots for reporting.

Out of scope (Phase 7 Feature 1):
- BI/dashboard UI.
- Full accounting/GL integration.
- Automated anomaly detection/alerting.

## Authority and Data Sources

- Inventory on-hand and deltas: movement ledger (Phase 0 Feature 1; Phase 2 Feature 1).
- Sales shipments: `sales_order_shipments` / `sales_order_shipment_lines` (Phase 4 Feature 1).
- Cycle counts and variance: `cycle_counts` / `cycle_count_lines` (Phase 2 Feature 3) and accuracy metrics (Phase 2 Feature 4).
- PPIS/ILFR definitions: Phase 5 Feature 4.

If sources disagree (e.g., shipments vs movements), treat as an integrity error, not a KPI reconciliation problem.

## KPI Definitions (Documented)

### Common dimensionality

KPI rollups may be reported by:
- time window (`window_start`, `window_end`)
- `item_id` and `uom` (when item-specific)
- `location_id` or `site_location_id` (policy-defined rollup)
- `customer_id` (service KPIs)

No unit conversions are performed.

### 1) Inventory turns

Inventory turns is a rate: usage over average inventory.

Phase 7 defines turns in quantity terms (not cost):
- `turns = total_outflow_qty / avg_on_hand_qty`

Zero handling (Phase 7 default):
- If `avg_on_hand_qty = 0`, set `turns = NULL` (undefined).

Where:
- `total_outflow_qty` is the total quantity issued/shipped in the window (by item/uom, optionally location/site).
- `avg_on_hand_qty` is the average on-hand quantity over the window.

Notes:
- Cost-based turns (COGS / avg inventory value) are out of scope without valuation.
- Negative inventory may cause negative averages; implementations must choose whether to clamp averages at zero for KPI presentation (policy).

### 2) DOI (Days of Inventory)

DOI is the inverse of turns scaled by days:
- `doi_days = avg_on_hand_qty / avg_daily_outflow_qty`

Where:
- `avg_daily_outflow_qty = total_outflow_qty / window_days`

Zero handling (Phase 7 default):
- If `avg_daily_outflow_qty = 0`, set `doi_days = NULL` (undefined).

### 3) Variance rollups (inventory accuracy)

Use cycle count variance snapshots (Phase 2 Feature 3/4):
- Per line: `variance_qty = counted - system`
- Per window: roll up absolute variance and weighted accuracy as described in Phase 2 Feature 4.

Phase 7 focuses on reporting cuts, not redefining the metric.

### 4) PPIS rollups

PPIS is computed as-of a point in time (Phase 5 Feature 4).
Rollups across items/locations require an explicit aggregation rule:

Phase 7 default aggregation:
- **Item-level PPIS**: compute PPIS per `(item_id, uom, site_location_id?)`.
- **Portfolio PPIS**: report distribution summaries (median/p50, p90) rather than averaging ratios.

### 5) ILFR rollups

ILFR is windowed and quantity-weighted (Phase 5 Feature 4).
Phase 7 supports rollups by:
- overall
- item/uom
- customer
- ship-from location

### 6) C2C (Cash-to-Cash) (definition + boundary)

C2C is typically:
- `c2c_days = dio_days + dso_days - dpo_days`

Where:
- DIO (days inventory outstanding) is a value-based DOI.
- DSO (days sales outstanding) depends on AR/invoicing.
- DPO (days payables outstanding) depends on AP.

Phase 7 documents the definition only. Without accounting/valuation, C2C cannot be computed accurately. If an implementation chooses a proxy, it must be explicitly labeled as such.
Note: Phase 7 does not compute DIO from quantity-based DOI; DIO is value-based and depends on inventory valuation (out of scope).

## Documented Computations (Logical)

### A) Total outflow quantity (shipments as proxy)

Phase 7 default: use shipments (documents) for outflow quantity because they represent fulfillment:
- For a window `[start, end)`:
  - `total_outflow_qty(item_id,uom) = sum(quantity_shipped)` from `sales_order_shipment_lines` joined to shipments with `shipped_at in [start,end)`.

If a stricter ledger-based approach is desired later, derive outflows from posted `issue` movements; that is a policy choice and must be consistent.

### B) Average on-hand quantity (window)

Two documented options (implementation must choose one consistently):

1. **As-of sampling** (simpler):
   - Compute on-hand as-of multiple timestamps in the window and average the samples.
2. **Ledger integration** (more accurate):
   - `avg_on_hand_qty = (integral of on_hand over time) / window_duration`
   - Requires reconstructing a step function from movement lines by `occurred_at`.

Phase 7 does not implement either method; it documents the options and requires choosing one during implementation.

### C) Turns and DOI

Given `total_outflow_qty` and `avg_on_hand_qty`:
- `turns = total_outflow_qty / avg_on_hand_qty` (when avg_on_hand_qty > 0)
- `avg_daily_outflow_qty = total_outflow_qty / window_days`
- `doi_days = avg_on_hand_qty / avg_daily_outflow_qty` (when avg_daily_outflow_qty > 0)

### D) Variance rollups

For a window `[start, end)` using posted cycle counts where `counted_at in [start,end)`:
- `total_abs_variance = sum(abs(variance_qty))`
- `total_system_qty = sum(system_quantity)`
- `weighted_variance_pct` and `weighted_accuracy_pct` per Phase 2 Feature 4.

### E) PPIS rollups

PPIS is computed as-of `as_of`:
- Prefer reporting PPIS percentiles across items rather than averaging.

### F) ILFR rollups

Compute ILFR per Phase 5 Feature 4 for the chosen window, then group by dimensions.

## Optional Snapshot Schemas (Docs Only)

### `kpi_runs`

Represents a KPI computation run for a time window or as-of point.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `draft`, `computed`, `published`, `archived` |
| `window_start` | `timestamptz` | yes | For windowed KPIs |
| `window_end` | `timestamptz` | yes | |
| `as_of` | `timestamptz` | yes | For as-of KPIs (PPIS) |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `check (status in ('draft','computed','published','archived'))`
- `index (status, created_at)`

### `kpi_snapshots`

Generic snapshot table for storing KPI values by dimension keys.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `kpi_run_id` | `uuid` | no | FK → `kpi_runs(id)` |
| `kpi_name` | `text` | no | enum-like: `turns`, `doi_days`, `weighted_accuracy_pct`, `ppis_days_p50`, `ppis_days_p90`, `ilfr` |
| `dimensions` | `jsonb` | no | Small key blob (item/location/customer/site/uom) |
| `value` | `numeric(18,6)` | yes | |
| `units` | `text` | yes | e.g., `ratio`, `days`, `pct` |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes (if materialized later):
- `foreign key (kpi_run_id) references kpi_runs(id)`
- `index (kpi_run_id, kpi_name)`

### `kpi_rollup_inputs` (Optional, Docs Only)

Optional intermediate storage of numerator/denominator values for auditability.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `kpi_run_id` | `uuid` | no | FK → `kpi_runs(id)` |
| `metric_name` | `text` | no | e.g., `turns_inputs`, `doi_inputs`, `ilfr_inputs` |
| `dimensions` | `jsonb` | no | |
| `numerator_qty` | `numeric(18,6)` | yes | |
| `denominator_qty` | `numeric(18,6)` | yes | |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes (if materialized later):
- `foreign key (kpi_run_id) references kpi_runs(id)`
- `index (kpi_run_id, metric_name)`

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- KPI runs are snapshots; do not mutate computed history. Recompute to generate new snapshots.
- UOM consistency: no unit conversions; computations must not mix UOMs in numerators/denominators.
- If a KPI requires missing upstream data (e.g., C2C without AR/AP/valuation), the KPI must be `NULL` or explicitly labeled as a proxy.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines KPI formulas for turns, DOI, variance rollups, PPIS rollups, and ILFR rollups, including default zero-handling conventions where applicable.
2. Documentation defines the C2C definition and explicitly documents why accurate computation requires valuation + AR/AP data (out of scope), preventing accidental “fake C2C”.
3. Documentation defines documented computation approaches for outflow quantity and average on-hand, with an explicit requirement to choose one approach at implementation time.
4. Documentation defines optional snapshot schemas (`kpi_runs`, `kpi_snapshots`, optional `kpi_rollup_inputs`) as docs-only.
5. No production code is added (no migrations executed, no ETL/jobs, no runtime implementation).
