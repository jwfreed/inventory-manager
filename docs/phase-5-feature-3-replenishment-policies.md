# Phase 5 — Feature 3: Replenishment Policies (Q,ROP) and (T,OUL) + Safety Stock via PPIS — Schemas + Computations + Acceptance Criteria Only

This document defines **schemas** and **documented computations** for replenishment policy models:
- Continuous review: **(Q, ROP)** (fixed order quantity, reorder point)
- Periodic review: **(T, OUL)** (review period, order-up-to level)
- Safety stock via **PPIS** (Periods of Protection / inventory coverage)

It is **documentation only** (no migrations, no replenishment engine implementation, no production code).

## Scope

Supports:
- Defining item/site replenishment policies and parameters.
- Computing recommended replenishment quantities based on policy, on-hand, and demand rate estimates.
- Integrating with MRP/MPS outputs as optional demand/supply inputs (docs-only).

Out of scope (Phase 5 Feature 3):
- Supplier selection and PO creation.
- Constraints optimization/capacity planning.
- Dynamic service-level optimization.

## Source of Truth and Authority Boundaries

- Inventory movements remain authoritative for on-hand (Phase 2 Feature 1).
- Demand estimation inputs (forecast, SO demand, historical usage) are documented but not implemented.
- Replenishment recommendations are planning artifacts; they do not move inventory.

## Canonical Dimensions

All quantities are computed per:
- `item_id`
- `uom`
- `site_location_id` (optional planning context)

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `replenishment_policies`

Defines a replenishment policy for an item at a site/location context.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `site_location_id` | `uuid` | yes | FK → `locations(id)`; optional site/DC |
| `policy_type` | `text` | no | enum-like: `q_rop`, `t_oul` |
| `status` | `text` | no | enum-like: `active`, `inactive` |
| `lead_time_days` | `integer` | yes | >= 0; planning lead time |
| `demand_rate_per_day` | `numeric(18,6)` | yes | >= 0; estimated average demand |
| `safety_stock_method` | `text` | no | enum-like: `none`, `fixed`, `ppis` |
| `safety_stock_qty` | `numeric(18,6)` | yes | >= 0; used if method=`fixed` |
| `ppis_periods` | `integer` | yes | > 0; periods of protection if method=`ppis` |
| `review_period_days` | `integer` | yes | > 0; used for `t_oul` |
| `order_up_to_level_qty` | `numeric(18,6)` | yes | >= 0; used for `t_oul` |
| `reorder_point_qty` | `numeric(18,6)` | yes | >= 0; used for `q_rop` |
| `order_quantity_qty` | `numeric(18,6)` | yes | > 0; used for `q_rop` |
| `min_order_qty` | `numeric(18,6)` | yes | >= 0; optional floor |
| `max_order_qty` | `numeric(18,6)` | yes | >= 0; optional ceiling |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (item_id) references items(id)`
- `foreign key (site_location_id) references locations(id)`
- `check (policy_type in ('q_rop','t_oul'))`
- `check (status in ('active','inactive'))`
- `check (lead_time_days is null or lead_time_days >= 0)`
- `check (demand_rate_per_day is null or demand_rate_per_day >= 0)`
- `check (safety_stock_method in ('none','fixed','ppis'))`
- `check (safety_stock_qty is null or safety_stock_qty >= 0)`
- `check (ppis_periods is null or ppis_periods > 0)`
- `check (review_period_days is null or review_period_days > 0)`
- `check (order_up_to_level_qty is null or order_up_to_level_qty >= 0)`
- `check (reorder_point_qty is null or reorder_point_qty >= 0)`
- `check (order_quantity_qty is null or order_quantity_qty > 0)`
- `check (min_order_qty is null or min_order_qty >= 0)`
- `check (max_order_qty is null or max_order_qty >= 0)`
- `unique (item_id, uom, site_location_id)` (one active policy per dimension; status handles activation)
- `index (status, policy_type)`

### `replenishment_recommendations` (Optional, Docs Only)

Stores computed replenishment recommendations as a snapshot for reporting.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `replenishment_policy_id` | `uuid` | no | FK → `replenishment_policies(id)` |
| `as_of` | `timestamptz` | no | Snapshot time |
| `on_hand_qty` | `numeric(18,6)` | no | Ledger-derived |
| `on_order_qty` | `numeric(18,6)` | yes | Optional pipeline qty |
| `reserved_qty` | `numeric(18,6)` | yes | Optional (Phase 4 Feature 3) |
| `effective_available_qty` | `numeric(18,6)` | no | Derived (policy) |
| `safety_stock_qty` | `numeric(18,6)` | no | Derived |
| `recommended_order_qty` | `numeric(18,6)` | no | Derived |
| `policy_type` | `text` | no | Denormalized |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (replenishment_policy_id) references replenishment_policies(id)`
- `check (recommended_order_qty >= 0)`
- `index (replenishment_policy_id, as_of)`

## Documented Computations

### Common inputs

All policies may use these quantities as-of `as_of`:
- `on_hand_qty`: ledger-derived on-hand (Phase 2 Feature 1), optionally site-scoped by `site_location_id` rollup policy.
- `on_order_qty` (optional): pipeline from purchasing (Phase 2 Feature 1).
- `reserved_qty` (optional): reservations (Phase 4 Feature 3).

Effective available (policy-defined):
- Phase 5 default: `effective_available_qty = on_hand_qty - reserved_qty` (treat `on_order_qty` as a separate pipeline signal), unless a policy explicitly opts into including on-order.
- Alternative policy (if explicitly chosen): `effective_available_qty = on_hand_qty - reserved_qty + on_order_qty` (treat nulls as 0). The chosen policy must be consistent.

Demand rate:
- `demand_rate_per_day` is an input parameter; estimation method is out of scope.

### Safety stock via PPIS

PPIS (Periods of Protection / inventory coverage) interprets safety stock as a coverage horizon:
- `safety_stock_qty = demand_rate_per_day * (ppis_periods * bucket_days)`

Where:
- PPIS is interpreted in days by default (`bucket_days=1`) unless the implementation explicitly declares bucket-based coverage (e.g., weekly = 7).
- Phase 5 requires a single declared rule for `bucket_days`/coverage conversion per run/policy.

### (Q, ROP) policy

Inputs:
- `reorder_point_qty` (ROP) or computed ROP from demand and lead time
- `order_quantity_qty` (Q)

Reorder point computation (if not explicitly set):
- `rop = demand_rate_per_day * lead_time_days + safety_stock_qty`

Trigger:
- If `effective_available_qty <= rop`, then recommend ordering.

Negative on-hand handling (Phase 5): if `on_hand_qty` is negative, triggers apply normally (it increases urgency); no clamping is performed unless explicitly configured.

Quantity:
- Base `recommended_order_qty = Q`
- Apply min/max constraints:
  - `recommended_order_qty = max(recommended_order_qty, min_order_qty)` if set
  - `recommended_order_qty = min(recommended_order_qty, max_order_qty)` if set

### (T, OUL) policy

Inputs:
- `review_period_days` (T)
- `order_up_to_level_qty` (OUL) or computed OUL from demand and lead time + review period

Order-up-to computation (if not explicitly set):
- `oul = demand_rate_per_day * (lead_time_days + review_period_days) + safety_stock_qty`

Trigger:
- Run at review cadence (periodic). For docs, treat every computation as a review.

Quantity:
- `recommended_order_qty = max(oul - effective_available_qty, 0)`
- Apply min/max constraints as above.

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- Policy completeness: required fields must be present for the chosen `policy_type` and `safety_stock_method` (not fully enforceable via basic constraints).
- UOM consistency: no unit conversions; all inputs must be consistent per `(item_id, uom)`.
- Immutability: computed recommendations are snapshots; do not edit history—recompute and store a new recommendation row if material.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines a `replenishment_policies` schema supporting `q_rop` and `t_oul` with parameter fields and constraints.
2. Documentation defines safety stock methods including PPIS and documents the PPIS safety stock computation.
3. Documentation defines computations for (Q,ROP) triggers and order quantity, and for (T,OUL) review and order quantity, including min/max constraints.
4. Documentation defines optional `replenishment_recommendations` as docs-only with snapshot semantics.
5. No production code is added (no migrations executed, no replenishment engine implementation).
