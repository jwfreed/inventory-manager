# Phase 6 — Feature 1: DRP (Distribution Requirements Planning) — Time-Phased Transfer Planning (Schemas + Computations + Acceptance Criteria Only)

This document defines **schemas** and **documented computations** for DRP: time-phased transfer planning for downstream nodes (DCs/stores) replenished from upstream nodes.
It is **documentation only** (no migrations, no planning engine implementation, no production code).

## Scope

Supports:
- Modeling a distribution network (nodes and lanes) with lead times.
- Time-phased netting of downstream demand against on-hand and scheduled receipts.
- Generating planned transfer orders (ship/release at source, receive at destination) with lead-time offsets.
- Optional lot-sizing and safety stock at nodes.

Out of scope (Phase 6 Feature 1):
- Transportation capacity constraints, consolidation optimization, and routing.
- Multi-stop loads and carrier tendering.
- Dynamic rebalancing/optimization and substitution.

## Source of Truth and Authority Boundaries

- Inventory movements remain authoritative for on-hand (Phase 2 Feature 1).
- Sales demand and shipments are authoritative for downstream demand signals (Phase 4).
- DRP outputs are planning artifacts; they do not move inventory.

## Canonical Dimensions

All quantities are computed per:
- `item_id`
- `uom`
- `node_location_id` (a location representing a node)
- `period` (time bucket)

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `drp_runs`

Represents a single DRP run for a planning horizon and bucket type.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `draft`, `computed`, `published`, `archived` |
| `bucket_type` | `text` | no | enum-like: `day`, `week`, `month` |
| `starts_on` | `date` | no | Inclusive start date |
| `ends_on` | `date` | no | Inclusive end date |
| `as_of` | `timestamptz` | no | Snapshot boundary for on-hand and scheduled receipts |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `check (status in ('draft','computed','published','archived'))`
- `check (bucket_type in ('day','week','month'))`
- `check (starts_on <= ends_on)`
- `index (status)`
- `index (starts_on, ends_on)`

### `drp_nodes`

Defines the network nodes (typically a subset of `locations` representing sites/DCs/stores).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `code` | `text` | no | Unique business identifier |
| `location_id` | `uuid` | no | FK → `locations(id)` |
| `node_type` | `text` | no | enum-like: `plant`, `dc`, `store` |
| `active` | `boolean` | no | default true |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `unique (code)`
- `foreign key (location_id) references locations(id)`
- `check (node_type in ('plant','dc','store'))`
- `unique (location_id)`
- `index (node_type, active)`

### `drp_lanes`

Defines replenishment lanes (source → destination) used for planned transfers.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `from_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `active` | `boolean` | no | default true |
| `transfer_lead_time_days` | `integer` | no | >= 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (from_node_id) references drp_nodes(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `check (from_node_id <> to_node_id)`
- `check (transfer_lead_time_days >= 0)`
- `unique (from_node_id, to_node_id)`
- `index (to_node_id, active)`

### `drp_item_policies`

Planning parameters per item at a destination node for a run (run-scoped snapshot).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `preferred_from_node_id` | `uuid` | yes | FK → `drp_nodes(id)`; lane selection policy |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `safety_stock_qty` | `numeric(18,6)` | yes | >= 0 |
| `lot_sizing_method` | `text` | no | enum-like: `l4l`, `foq` |
| `foq_qty` | `numeric(18,6)` | yes | Required if method=`foq`; > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `foreign key (preferred_from_node_id) references drp_nodes(id)`
- `foreign key (item_id) references items(id)`
- `check (safety_stock_qty is null or safety_stock_qty >= 0)`
- `check (lot_sizing_method in ('l4l','foq'))`
- `check (foq_qty is null or foq_qty > 0)`
- `unique (drp_run_id, to_node_id, item_id, uom)`
- `index (drp_run_id, to_node_id)`

### `drp_periods` (Optional, Docs Only)

Materialized period rows for a run (can also be derived at runtime).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `period_start` | `date` | no | Inclusive |
| `period_end` | `date` | no | Inclusive |
| `sequence` | `integer` | no | 1-based |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `unique (drp_run_id, sequence)`
- `unique (drp_run_id, period_start, period_end)`
- `index (drp_run_id, period_start)`

### `drp_gross_requirements`

Time-phased gross requirements at a node (demand).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `period_start` | `date` | no | |
| `source_type` | `text` | no | enum-like: `forecast`, `sales_orders`, `dependent` |
| `source_ref` | `text` | yes | |
| `quantity` | `numeric(18,6)` | no | >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `foreign key (item_id) references items(id)`
- `check (source_type in ('forecast','sales_orders','dependent'))`
- `check (quantity >= 0)`
- `index (drp_run_id, to_node_id, item_id, period_start)`

### `drp_scheduled_receipts` (Optional, Docs Only)

Time-phased scheduled receipts at a node (pipeline supply already expected).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `period_start` | `date` | no | |
| `source_type` | `text` | no | enum-like: `planned_transfers`, `purchase_orders`, `work_orders` |
| `source_ref` | `text` | yes | |
| `quantity` | `numeric(18,6)` | no | >= 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `foreign key (item_id) references items(id)`
- `check (source_type in ('planned_transfers','purchase_orders','work_orders'))`
- `check (quantity >= 0)`
- `index (drp_run_id, to_node_id, item_id, period_start)`

### `drp_plan_lines`

Computed DRP outputs per node/item/period.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `period_start` | `date` | no | |
| `begin_on_hand_qty` | `numeric(18,6)` | yes | Snapshot |
| `gross_requirements_qty` | `numeric(18,6)` | yes | Sum of gross req |
| `scheduled_receipts_qty` | `numeric(18,6)` | yes | Sum of scheduled receipts |
| `net_requirements_qty` | `numeric(18,6)` | yes | Computed |
| `planned_transfer_receipt_qty` | `numeric(18,6)` | yes | After lot sizing |
| `planned_transfer_release_qty` | `numeric(18,6)` | yes | Time-shifted to source ship period |
| `projected_end_on_hand_qty` | `numeric(18,6)` | yes | Computed |
| `computed_at` | `timestamptz` | yes | |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `foreign key (item_id) references items(id)`
- `unique (drp_run_id, to_node_id, item_id, uom, period_start)`
- `index (drp_run_id, period_start)`

### `drp_planned_transfers`

Normalized planned transfer orders created by DRP (receipt at destination, release/ship at source).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `drp_run_id` | `uuid` | no | FK → `drp_runs(id)` |
| `from_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `to_node_id` | `uuid` | no | FK → `drp_nodes(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `quantity` | `numeric(18,6)` | no | > 0 |
| `release_date` | `date` | no | Planned ship/release date |
| `receipt_date` | `date` | no | Planned receipt date |
| `lane_id` | `uuid` | yes | FK → `drp_lanes(id)` |
| `source_ref` | `text` | yes | e.g., which plan line drove it |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (drp_run_id) references drp_runs(id)`
- `foreign key (from_node_id) references drp_nodes(id)`
- `foreign key (to_node_id) references drp_nodes(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (lane_id) references drp_lanes(id)`
- `check (from_node_id <> to_node_id)`
- `check (quantity > 0)`
- `check (release_date <= receipt_date)`
- `index (drp_run_id, release_date)`

## Documented Computations

### 1) Demand at downstream nodes (gross requirements)

For each destination node and period, gross requirements can come from:
- Sales-order demand (Phase 4 SOs/shipments) aggregated into periods, or
- Forecast inputs (docs-only), or
- Dependent demand from downstream nodes (multi-echelon; optional)

Dependent demand is supported as an input shape but is off by default unless a separate multi-echelon policy is enabled at implementation time.

Phase 6 does not implement demand ingestion; it documents the aggregation shape.

### 2) Netting logic per node/item/period

For each destination node `n`, item `i`, period `t`:
- `gross_requirements_qty = sum(drp_gross_requirements.quantity)`
- `scheduled_receipts_qty = sum(drp_scheduled_receipts.quantity)` (if modeled; else 0)
- Seed `begin_on_hand_qty` at `t0` from ledger on-hand as-of `drp_runs.as_of` for `(item_id, node.location_id, uom)` (or site rollup policy).
- Recurrence: `begin_on_hand_t = (t == t0 ? ledger_on_hand_as_of : projected_end_on_hand_{t-1})`

Projected available before transfers:
- `projected_available = begin_on_hand_qty + scheduled_receipts_qty - gross_requirements_qty`

Safety stock:
- `safety_stock_qty` from `drp_item_policies` (null treated as 0).

Net requirements:
- `net_requirements_qty = max(safety_stock_qty - projected_available, 0)`

### 3) Planned transfer receipts and lot sizing

Compute preliminary transfer receipt:
- `transfer_receipt_qty = net_requirements_qty`

Apply lot sizing (per `drp_item_policies`):
- L4L: `planned_transfer_receipt_qty = transfer_receipt_qty`
- FOQ: if `transfer_receipt_qty > 0`, round up to next multiple of `foq_qty`

Update projected end on-hand:
- `projected_end_on_hand_qty = projected_available + planned_transfer_receipt_qty`

### 4) Lead-time offsets: transfer release/ship

Select a lane:
- Phase 6 baseline uses `preferred_from_node_id` if set; otherwise lane selection is policy-defined.
  - Phase 6 default: select the single active lane into `to_node_id` with the lowest `transfer_lead_time_days`; if ties exist, fail publishing unless a `preferred_from_node_id` is set.

Convert lane lead time days to period offsets deterministically (ceil/floor policy; global per run):
- `offset_periods = ceil(transfer_lead_time_days / bucket_days)` (example)

Release period:
- `release_period = receipt_period - offset_periods`

Planned transfer order:
- Receipt at destination in `receipt_period`
- Release/ship at source in `release_period`

### 5) Source feasibility (documented)

Phase 6 documents a key constraint but does not implement optimization:
- Planned transfers should be checked against source availability (on-hand and upstream allocations) as a posting-time validation policy for publishing the run.
- If infeasible, either:
  - allow negative projected availability at source (policy), or
  - flag as exception for planner review.

Phase 6 default: publish is allowed even if source feasibility is violated, but must emit an exception record (docs-only) or mark plan lines with a flag (implementation-time).

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- Run immutability: once a `drp_run` is `published`, inputs used for that run must not be modified; changes require a new run.
- Determinism: lead-time days → period offsets must be a single declared rule per run (ceil/floor).
- Lane integrity: transfers must reference an active lane; lane lead times must be non-negative.
- UOM consistency: no conversions; all inputs must be consistent per `(item_id, uom)`.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines schemas for DRP runs, nodes, lanes, item policies, gross requirements, and computed plan lines.
2. Documentation defines optional scheduled receipts and optional periods as docs-only schemas.
3. Documentation defines netting computations per node/period, including recurrence and safety stock.
4. Documentation defines planned transfer receipt/release computations with deterministic lead-time offsets and lot sizing.
5. No production code is added (no migrations executed, no DRP engine implementation).
