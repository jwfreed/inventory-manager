# Phase 5 — Feature 4: Service Metrics (PPIS, ILFR) — Definitions, Computations, Optional Snapshot Schemas (Docs Only)

This document defines **service metrics** and how to compute them:
- **PPIS** (Periods of Protection / inventory coverage)
- **ILFR** (Item Line Fill Rate)

It also defines **optional snapshot schemas** for storing computed metrics.
It is **documentation only** (no migrations, no scheduled jobs, no runtime implementation).

## Scope

Supports:
- Defining PPIS and ILFR with explicit formulas and dimensionality.
- Computing metrics from existing documents (sales orders/shipments, replenishment inputs) and ledger-derived on-hand.
- Optional storage of computed metric snapshots for reporting.

Out of scope (Phase 5 Feature 4):
- BI/dashboard implementation.
- Service level optimization and closed-loop control.
- Perfect order / OTIF / on-time delivery metrics.

## Authority and Data Sources

- On-hand comes from the movement ledger (Phase 2 Feature 1).
- Demand/fulfillment comes from sales documents (Phase 4 Feature 1 and Phase 4 Feature 4 execution).
- Reservations are optional inputs for certain “available” definitions (Phase 4 Feature 3).

Metrics are reporting artifacts; they do not move inventory.

## Metric Definitions (Documented)

### PPIS (coverage)

PPIS expresses how long current inventory will last given a demand rate.

Dimensions:
- `(item_id, uom, site_location_id?)`

Inputs (as-of time `t`):
- `on_hand_qty(t)` (ledger-derived; optionally site-scoped)
- `reserved_qty(t)` (optional)
- `effective_available_qty(t)` (policy-defined; default aligns with Phase 5 Feature 3)
- `demand_rate_per_day` (estimated; method out of scope)

Phase 5 default:
- `effective_available_qty(t) = on_hand_qty(t) - reserved_qty(t)` (treat null reserved as 0)

Formula:
- If `demand_rate_per_day > 0`: `ppis_days = effective_available_qty / demand_rate_per_day`
- If `demand_rate_per_day = 0`: `ppis_days = NULL` (Phase 5 default; avoid reporting “infinite” unless a later phase standardizes it)

Notes:
- Negative PPIS is possible if effective availability is negative; this indicates a deficit/backorder situation.
- No unit conversions; demand rate must be in the same UOM/day.

### ILFR (Item Line Fill Rate)

ILFR measures the fraction of ordered quantity that was shipped, aggregated across order lines in a time window.

Dimensions (common cuts):
- overall
- by `(item_id, uom)`
- by `customer_id`
- by `ship_from_location_id`
- by time window (e.g., weekly/monthly)

Definition (quantity-weighted, Phase 5 default):
For each sales order line:
- `qty_ordered = sales_order_lines.quantity_ordered`
- `qty_shipped = sum(sales_order_shipment_lines.quantity_shipped)` for that line
- `line_fill = min(qty_shipped, qty_ordered) / qty_ordered` (cap at 1 to avoid over-ship inflating service)

Aggregate ILFR over a population of lines:
- `ilfr = sum(min(qty_shipped, qty_ordered)) / sum(qty_ordered)`

If `sum(qty_ordered) = 0` for a window, Phase 5 default is `ilfr = NULL` (undefined due to no demand in-window).

Windowing:
- Define the reporting window by shipment `shipped_at` (default) or order `order_date` (alternate policy).
- Phase 5 default: use `shipped_at` to reflect actual fulfillment.

Notes:
- Backorders/late shipments influence ILFR depending on the chosen windowing policy.
- Over-shipments are capped at the ordered quantity for ILFR.

## Documented Computations

### PPIS computation (as-of)

1. Compute `on_hand_qty(t)` from ledger as-of `t` per `(item_id, location_id, uom)` then roll up to site if policy defines a site rollup.
2. Compute `reserved_qty(t)` per `(item_id, location_id, uom)` (Phase 4 Feature 3) and roll up similarly.
3. Compute `effective_available_qty(t)` using the Phase 5 default (or explicitly chosen policy).
4. Compute `ppis_days` as above using `demand_rate_per_day`.

### ILFR computation (windowed)

For a time window `[start, end)`:
1. Select relevant sales order lines (policy: all submitted+ lines, or all lines with shipments in window).
2. Compute `qty_shipped` from shipment lines with parent shipment `shipped_at` within the window.
3. Compute capped shipped quantity: `capped = min(qty_shipped, qty_ordered)`.
4. Compute ILFR: `sum(capped) / sum(qty_ordered)`.

## Optional Snapshot Schemas (Docs Only)

### `service_metric_snapshots`

Generic snapshot table for storing computed metrics by dimension keys.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `metric_name` | `text` | no | enum-like: `ppis_days`, `ilfr` |
| `window_start` | `timestamptz` | yes | For windowed metrics (ILFR) |
| `window_end` | `timestamptz` | yes | |
| `as_of` | `timestamptz` | yes | For as-of metrics (PPIS) |
| `dimensions` | `jsonb` | no | Small dimension key blob (e.g., `{item_id, uom, site_location_id}`) |
| `value` | `numeric(18,6)` | yes | Metric value |
| `units` | `text` | yes | e.g., `days`, `ratio` |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes (if materialized later):
- `check (metric_name in ('ppis_days','ilfr'))`
- `index (metric_name, computed_at)`
- `index (window_start, window_end)` (optional)

### `ilfr_line_rollups` (Optional, Docs Only)

Optional rollup table to store intermediate ILFR numerators/denominators for auditability.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `window_start` | `timestamptz` | no | |
| `window_end` | `timestamptz` | no | |
| `item_id` | `uuid` | yes | |
| `uom` | `text` | yes | |
| `ship_from_location_id` | `uuid` | yes | |
| `customer_id` | `uuid` | yes | |
| `numerator_qty` | `numeric(18,6)` | no | sum(min(shipped, ordered)) |
| `denominator_qty` | `numeric(18,6)` | no | sum(ordered) |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes (if materialized later):
- `foreign key (item_id) references items(id)`
- `foreign key (ship_from_location_id) references locations(id)`
- `foreign key (customer_id) references customers(id)`
- `check (denominator_qty >= 0)`
- `index (window_start, window_end)`

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines PPIS (coverage) with explicit formulas, default availability definition, and zero-demand handling policy.
2. Documentation defines ILFR with explicit formulas, over-ship capping, and default windowing by `shipped_at`.
3. Documentation defines documented computation steps for both PPIS and ILFR and identifies authoritative source tables.
4. Documentation defines optional snapshot schemas (`service_metric_snapshots` and optional `ilfr_line_rollups`) as docs-only.
5. No production code is added (no migrations executed, no scheduled jobs, no runtime implementation).
