# Phase 5 — Feature 1: Master Production Schedule (MPS) (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **documented computations** for a Master Production Schedule (MPS).
It is **documentation only** (no migrations, no planning engine implementation, no production code).

## Scope

Supports:
- Defining an MPS plan for finished goods (items to be produced) over time buckets.
- Capturing demand signals (forecast and/or sales-order demand aggregation) as inputs.
- Computing net requirements and planned production quantities per period.
- Optionally linking planned production to work orders (Phase 3 Feature 2) in later implementation.

Out of scope (Phase 5 Feature 1):
- Detailed capacity planning, constraints optimization, and multi-level MRP explosion.
- Supplier planning, lead times, and purchase planning.
- Automated creation/release of work orders (docs define linkages only).

## Conceptual Model

### MPS as a Planning Read Model

- The MPS is a plan for **what** to produce and **when**.
- MPS does not move inventory; inventory authority remains the movement ledger (Phase 0 Feature 1).
- MPS computations use:
  - On-hand (Phase 2 Feature 1),
  - Demand (forecast + sales order demand),
  - Supply already scheduled (released work orders, if modeled).

### Canonical Dimensions

All quantities are computed per:
- `item_id`
- `uom`
- `time_bucket` (period)

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `mps_plans`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `code` | `text` | no | Unique business identifier |
| `status` | `text` | no | enum-like: `draft`, `published`, `archived` |
| `bucket_type` | `text` | no | enum-like: `day`, `week`, `month` |
| `starts_on` | `date` | no | Inclusive plan start date |
| `ends_on` | `date` | no | Inclusive plan end date |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (code)`
- `check (status in ('draft','published','archived'))`
- `check (bucket_type in ('day','week','month'))`
- `check (starts_on <= ends_on)`
- `index (status)`
- `index (starts_on, ends_on)`

### `mps_plan_items`

Defines which finished goods are planned in an MPS and the initial planning parameters.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_id` | `uuid` | no | FK → `mps_plans(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions in Phase 5 |
| `site_location_id` | `uuid` | yes | FK → `locations(id)`; optional site/DC planning context |
| `safety_stock_qty` | `numeric(18,6)` | yes | Optional; >= 0 |
| `lot_size_qty` | `numeric(18,6)` | yes | Optional; > 0 if used |
| `lead_time_days` | `integer` | yes | Optional planning lead time; >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mps_plan_id) references mps_plans(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (safety_stock_qty is null or safety_stock_qty >= 0)`
- `check (lot_size_qty is null or lot_size_qty > 0)`
- `check (lead_time_days is null or lead_time_days >= 0)`
- `unique (mps_plan_id, item_id, uom, site_location_id)`
- `index (mps_plan_id)`

### `mps_periods`

Materialized period rows for a plan (docs-only; can also be derived at runtime).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_id` | `uuid` | no | FK → `mps_plans(id)` |
| `period_start` | `date` | no | Inclusive |
| `period_end` | `date` | no | Inclusive |
| `sequence` | `integer` | no | Monotonic, 1-based |

Constraints / indexes:
- `foreign key (mps_plan_id) references mps_plans(id)`
- `unique (mps_plan_id, sequence)`
- `unique (mps_plan_id, period_start, period_end)`
- `check (period_start <= period_end)`
- `index (mps_plan_id, period_start)`

### `mps_demand_inputs`

Captures demand inputs per period for a planned item.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_item_id` | `uuid` | no | FK → `mps_plan_items(id)` |
| `mps_period_id` | `uuid` | no | FK → `mps_periods(id)` |
| `demand_type` | `text` | no | enum-like: `forecast`, `sales_orders` |
| `quantity` | `numeric(18,6)` | no | Must be >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mps_plan_item_id) references mps_plan_items(id)`
- `foreign key (mps_period_id) references mps_periods(id)`
- `check (demand_type in ('forecast','sales_orders'))`
- `check (quantity >= 0)`
- `unique (mps_plan_item_id, mps_period_id, demand_type)`

### `mps_supply_inputs` (Optional, Docs Only)

Captures pre-scheduled supply per period (e.g., released work orders expected to complete).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_item_id` | `uuid` | no | FK → `mps_plan_items(id)` |
| `mps_period_id` | `uuid` | no | FK → `mps_periods(id)` |
| `supply_type` | `text` | no | enum-like: `work_orders` |
| `quantity` | `numeric(18,6)` | no | Must be >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (mps_plan_item_id) references mps_plan_items(id)`
- `foreign key (mps_period_id) references mps_periods(id)`
- `check (supply_type in ('work_orders'))`
- `check (quantity >= 0)`
- `unique (mps_plan_item_id, mps_period_id, supply_type)`

### `mps_plan_lines`

Computed planning outputs per item and period.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `mps_plan_item_id` | `uuid` | no | FK → `mps_plan_items(id)` |
| `mps_period_id` | `uuid` | no | FK → `mps_periods(id)` |
| `begin_on_hand_qty` | `numeric(18,6)` | yes | Snapshot at period start; >= 0 in planning math, ledger can be negative |
| `demand_qty` | `numeric(18,6)` | yes | Sum of demand inputs |
| `scheduled_receipts_qty` | `numeric(18,6)` | yes | Sum of supply inputs |
| `net_requirements_qty` | `numeric(18,6)` | yes | Computed |
| `planned_production_qty` | `numeric(18,6)` | yes | Computed (may be lot-sized) |
| `projected_end_on_hand_qty` | `numeric(18,6)` | yes | Computed |
| `computed_at` | `timestamptz` | yes | When computed/materialized |

Constraints / indexes:
- `foreign key (mps_plan_item_id) references mps_plan_items(id)`
- `foreign key (mps_period_id) references mps_periods(id)`
- `unique (mps_plan_item_id, mps_period_id)`
- `index (mps_period_id)`

## Documented Computations

### Period demand and supply aggregation

For a plan item and period:
- `demand_qty = sum(mps_demand_inputs.quantity)` across demand types
- `scheduled_receipts_qty = sum(mps_supply_inputs.quantity)` across supply types (if used)

### Net requirements and planned production (single-level)

Given:
- `begin_on_hand_qty` (planning snapshot)
- `demand_qty`
- `scheduled_receipts_qty`
- `safety_stock_qty` (optional)

Safety stock dimensionality (Phase 5): `safety_stock_qty` is interpreted per period and is not time-phased in Phase 5 Feature 1.

Compute:
- `projected_available = begin_on_hand_qty + scheduled_receipts_qty - demand_qty`
- `net_requirements_qty = max(safety_stock_qty - projected_available, 0)` (if safety stock is null, treat as 0)
- `planned_production_qty = net_requirements_qty`, optionally adjusted by lot sizing:
  - If `lot_size_qty` is set: round up `planned_production_qty` to the next multiple of `lot_size_qty`.
- `projected_end_on_hand_qty = projected_available + planned_production_qty`

### Begin-on-hand snapshot source

Planning input for `begin_on_hand_qty` is derived from ledger on-hand (Phase 2 Feature 1), optionally scoped by `site_location_id` if the implementation chooses site-level planning:
- If `site_location_id` is set, the implementation must define which locations roll up into that site (policy/config later).
- Phase 5 documents the computation shape only; rollup policy is implementation-time.

If ledger-derived `begin_on_hand_qty` is negative, planning math may either (a) carry the negative forward, or (b) clamp to zero; the chosen behavior must be consistent and documented at implementation time.

### Demand input sourcing (docs-only)

Phase 5 documents demand categories without implementing sourcing:
- `forecast`: user/system-provided forecast per period.
- `sales_orders`: aggregated demand from SOs (e.g., submitted/partially_shipped), potentially reduced by shipped quantities and/or reservations (policy-defined in implementation).

## Posting-Time Validations (Documented)

### Plan integrity

Posting-time validation (application/service layer):
- `mps_periods` must fully cover the plan horizon (`starts_on`..`ends_on`) with non-overlapping, correctly ordered periods.
- MPS plan publishing is atomic: `status` transitions to `published` together with freezing inputs used for the published computation (implementation policy).
- Once `status='published'`, demand and supply inputs used for that publish must not be modified; changes require a new plan or reversion to `draft`.

### UOM and consistency

Posting-time validation:
- No unit conversions: demand/supply inputs must use the same `uom` as the `mps_plan_item`.
- If multiple sources disagree on UOM, publishing must fail.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines schemas for `mps_plans`, `mps_plan_items`, `mps_periods`, `mps_demand_inputs`, and `mps_plan_lines`.
2. Documentation defines optional `mps_supply_inputs` as docs-only and explains its use for scheduled receipts.
3. Documentation defines computations for demand aggregation, scheduled receipts, net requirements, planned production (including optional safety stock and lot sizing), and projected on-hand.
4. Documentation defines policy boundaries for begin-on-hand sourcing and demand sourcing (forecast vs sales orders) without implementing ingestion/engines.
5. No production code is added (no migrations executed, no planning engine, no ORM/runtime model implementation).
