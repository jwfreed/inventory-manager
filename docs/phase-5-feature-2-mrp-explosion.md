# Phase 5 — Feature 2: MRP Explosion (Time-Phased BOM, Lead-Time Offsets, Lot-Sizing) — Schemas + Documented Computations Only

This document defines **schemas** and **documented computations** for MRP explosion:
- Time-phased BOM explosion
- Lead-time offsets
- Lot-sizing policies: L4L / FOQ / POQ / PPB

It is **documentation only** (no migrations, no planning engine implementation, no production code).

## Scope

Supports:
- Exploding dependent demand from MPS planned production (Phase 5 Feature 1) across multi-level BOMs (Phase 3 Feature 1).
- Time-phased netting of gross requirements, scheduled receipts, and projected on-hand by period.
- Generating planned order receipts and planned order releases using lead time offsets.
- Applying lot-sizing rules to planned orders.

Out of scope (Phase 5 Feature 2):
- Capacity planning and constraints optimization.
- Supplier selection, purchasing execution, and vendor lead-time variability.
- Alternate BOMs, substitutions, and yield loss beyond the documented `scrap_factor`.

## Source of Truth and Authority Boundaries

- Inventory movements remain authoritative for on-hand (Phase 2 Feature 1).
- BOM definitions are authoritative for component structure (Phase 3 Feature 1).
- MPS plan lines are authoritative for independent demand to produce (Phase 5 Feature 1).

MRP outputs are planning artifacts; they do not move inventory.

## Canonical Dimensions

All quantities are computed per:
- `item_id`
- `uom`
- `site_location_id` (optional planning context)
- `period` (time bucket)

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `mrp_runs`

Represents a single MRP explosion run against an MPS plan (or a snapshot thereof).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_id` | `uuid` | no | FK → `mps_plans(id)` |
| `status` | `text` | no | enum-like: `draft`, `computed`, `published`, `archived` |
| `as_of` | `timestamptz` | no | Time boundary for on-hand and scheduled receipts snapshots |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mps_plan_id) references mps_plans(id)`
- `check (status in ('draft','computed','published','archived'))`
- `index (mps_plan_id, created_at)`
- `index (status)`

### `mrp_item_policies`

Planning parameters per item for an MRP run. These are run-scoped snapshots to avoid drift.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mrp_run_id` | `uuid` | no | FK → `mrp_runs(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `site_location_id` | `uuid` | yes | FK → `locations(id)`; optional |
| `planning_lead_time_days` | `integer` | yes | >= 0; may differ from MPS lead time |
| `safety_stock_qty` | `numeric(18,6)` | yes | >= 0 |
| `lot_sizing_method` | `text` | no | enum-like: `l4l`, `foq`, `poq`, `ppb` |
| `foq_qty` | `numeric(18,6)` | yes | Required if method = `foq`; > 0 |
| `poq_periods` | `integer` | yes | Required if method = `poq`; > 0 |
| `ppb_periods` | `integer` | yes | Required if method = `ppb`; > 0 (periods to bundle) |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mrp_run_id) references mrp_runs(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (planning_lead_time_days is null or planning_lead_time_days >= 0)`
- `check (safety_stock_qty is null or safety_stock_qty >= 0)`
- `check (lot_sizing_method in ('l4l','foq','poq','ppb'))`
- `check (foq_qty is null or foq_qty > 0)`
- `check (poq_periods is null or poq_periods > 0)`
- `check (ppb_periods is null or ppb_periods > 0)`
- `unique (mrp_run_id, item_id, uom, site_location_id)`
- `index (mrp_run_id)`

### `mrp_gross_requirements`

Time-phased gross requirements per item/period, separated by source for traceability.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mrp_run_id` | `uuid` | no | FK → `mrp_runs(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `site_location_id` | `uuid` | yes | FK → `locations(id)` |
| `period_start` | `date` | no | Bucket start (matches MPS bucket) |
| `source_type` | `text` | no | enum-like: `mps`, `bom_explosion` |
| `source_ref` | `text` | yes | Optional reference (e.g., MPS line id) |
| `quantity` | `numeric(18,6)` | no | >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mrp_run_id) references mrp_runs(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (source_type in ('mps','bom_explosion'))`
- `check (quantity >= 0)`
- `index (mrp_run_id, item_id, period_start)`

### `mrp_scheduled_receipts` (Optional, Docs Only)

Time-phased scheduled receipts (open POs, released work orders) by item/period.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mrp_run_id` | `uuid` | no | FK → `mrp_runs(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `site_location_id` | `uuid` | yes | FK → `locations(id)` |
| `period_start` | `date` | no | |
| `source_type` | `text` | no | enum-like: `purchase_orders`, `work_orders` |
| `source_ref` | `text` | yes | |
| `quantity` | `numeric(18,6)` | no | >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mrp_run_id) references mrp_runs(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (source_type in ('purchase_orders','work_orders'))`
- `check (quantity >= 0)`
- `index (mrp_run_id, item_id, period_start)`

### `mrp_plan_lines`

Computed MRP outputs per item/period.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mrp_run_id` | `uuid` | no | FK → `mrp_runs(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `site_location_id` | `uuid` | yes | FK → `locations(id)` |
| `period_start` | `date` | no | |
| `begin_on_hand_qty` | `numeric(18,6)` | yes | Snapshot |
| `gross_requirements_qty` | `numeric(18,6)` | yes | Sum of gross req |
| `scheduled_receipts_qty` | `numeric(18,6)` | yes | Sum of scheduled receipts |
| `net_requirements_qty` | `numeric(18,6)` | yes | Computed |
| `planned_order_receipt_qty` | `numeric(18,6)` | yes | After lot sizing |
| `planned_order_release_qty` | `numeric(18,6)` | yes | Same as receipt qty, time-shifted |
| `projected_end_on_hand_qty` | `numeric(18,6)` | yes | Computed |
| `computed_at` | `timestamptz` | yes | |

Constraints / indexes:
- `foreign key (mrp_run_id) references mrp_runs(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `unique (mrp_run_id, item_id, uom, site_location_id, period_start)`
- `index (mrp_run_id, period_start)`

### `mrp_planned_orders`

Optional normalized representation of planned orders (receipts/releases) created by MRP.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mrp_run_id` | `uuid` | no | FK → `mrp_runs(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `site_location_id` | `uuid` | yes | FK → `locations(id)` |
| `order_type` | `text` | no | enum-like: `planned_work_order`, `planned_purchase_order` |
| `quantity` | `numeric(18,6)` | no | > 0 |
| `release_date` | `date` | no | |
| `receipt_date` | `date` | no | |
| `source_ref` | `text` | yes | e.g., which gross requirement drove it |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mrp_run_id) references mrp_runs(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (order_type in ('planned_work_order','planned_purchase_order'))`
- `check (quantity > 0)`
- `check (release_date <= receipt_date)`
- `index (mrp_run_id, release_date)`

## Documented Computations

### 1) Time-phased BOM explosion (gross requirements)

For each planned production receipt in period `t` for parent item `P` with quantity `Qp`:

Select the applicable BOM version for `P` (Phase 3 Feature 1):
- Default recommendation (Phase 5): resolve BOM version by the planned receipt period date (more realistic), with `mrp_runs.as_of` used as a determinism anchor for snapshotting.
- Reject overlaps/multiple matches (posting-time validation policy).

For each BOM component line `(C, component_quantity, yield_quantity, scrap_factor)`:
- `component_per_parent_unit = component_quantity / yield_quantity`
- `gross_requirement_qty_for_C = Qp * component_per_parent_unit`
- If `scrap_factor` is used: multiply by `(1 + scrap_factor)`

Time-phasing (dependent demand date):
- If the parent’s planned receipt is in period `t`, then the component gross requirement occurs in period:
  - `t_component = t - offset_periods(planning_lead_time_of_C)`

Lead-time offset policy:
- Convert `planning_lead_time_days` to period offsets using the run’s bucket type.
- Use floor/ceil consistently (implementation policy).
  - Example: `offset_periods = ceil(planning_lead_time_days / bucket_days)` (or `floor`) — whichever you choose, must be global per run.

Multi-level explosion:
- Components that themselves have BOMs generate further dependent demand using the same logic (recursive), until leaf items.
- Cycle prevention is required (no BOM cycles).

### 2) Netting logic per item/period

For each item `i` and period `t`:
- `gross_requirements_qty = sum(mrp_gross_requirements.quantity)`
- `scheduled_receipts_qty = sum(mrp_scheduled_receipts.quantity)` (if modeled; else 0)
- `begin_on_hand_qty` comes from:
  - ledger-derived on-hand as-of `mrp_runs.as_of` (Phase 2 Feature 1), projected forward period-by-period, or
  - from the prior period’s `projected_end_on_hand_qty` (planning recurrence)

Recurrence (Phase 5): `begin_on_hand_t = (t == t0 ? ledger_on_hand_as_of : projected_end_on_hand_{t-1})`.

Projected available before planning receipts:
- `projected_available = begin_on_hand_qty + scheduled_receipts_qty - gross_requirements_qty`

Safety stock:
- `safety_stock_qty` from `mrp_item_policies` (null treated as 0).

Net requirements:
- `net_requirements_qty = max(safety_stock_qty - projected_available, 0)`

### 3) Lot-sizing methods

All methods operate on `net_requirements_qty` for period `t` and produce `planned_order_receipt_qty` (PORcpt).

#### L4L (Lot-for-lot)
- `PORcpt_t = net_requirements_t`

#### FOQ (Fixed Order Quantity)
- If `net_requirements_t = 0`: `PORcpt_t = 0`
- Else: `PORcpt_t = ceil(net_requirements_t / foq_qty) * foq_qty`

#### POQ (Period Order Quantity)

Group requirements across a window of `poq_periods` starting at `t`:
- `window_net = sum(net_requirements_{t..t+poq_periods-1})`
- `PORcpt_t = window_net` (or lot-sized further by FOQ if the policy chooses; out of scope)
- Set `PORcpt_{t+1..t+poq_periods-1} = 0` for the grouped periods.

#### PPB (Part-Period Balancing)

Phase 5 documents PPB as a time-bucket approximation (no cost model beyond “periods”):
- Choose `ppb_periods` as the balancing horizon (a simplified PPB).
- `PORcpt_t = sum(net_requirements_{t..t+ppb_periods-1})`
- Set subsequent periods in that horizon to 0 as in POQ.

Note: True PPB usually balances holding vs setup costs; Phase 5 uses `ppb_periods` as an explicit simplified proxy.

### 4) Lead-time offsets: planned order release

For each planned order receipt in period `t` with lead time `L`:
- `release_period = t - offset_periods(L)`
- `planned_order_release_qty` is scheduled in `release_period`.

Release date and receipt date mapping:
- Use the period start date as the canonical date for the period in Phase 5 (policy); alternatives (end/mid) are out of scope.

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- Run immutability: once an `mrp_run` is `published`, inputs used for that run must not be modified; changes require a new run.
- UOM consistency: no unit conversions; item policies, BOM lines, and gross requirements must be consistent per `(item_id, uom)`.
- Lead-time and bucket alignment: converting days to periods must be deterministic and documented (ceil/floor policy).
- BOM version resolution must be deterministic and reject overlaps.
- Cycle detection: BOM cycles must be rejected.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines schemas for `mrp_runs`, `mrp_item_policies`, `mrp_gross_requirements`, `mrp_plan_lines`, and `mrp_planned_orders`.
2. Documentation defines optional `mrp_scheduled_receipts` as docs-only and explains its role in netting.
3. Documentation defines time-phased BOM explosion across multiple levels, including lead-time offsets for dependent demand.
4. Documentation defines netting computations per period (gross req, scheduled receipts, projected available, net req, planned receipts).
5. Documentation defines lot-sizing computations for L4L, FOQ, POQ, and PPB.
6. No production code is added (no migrations executed, no planning engine implementation).
