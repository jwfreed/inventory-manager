# Phase 2 — Feature 1: On-hand + Inventory Position Derivation (Schemas + Documented Computations Only)

This document defines **read-model schemas (optional)** and **documented computations** for deriving:
- On-hand inventory
- Inventory position (on-hand segmented by disposition and pipeline quantities)

It is **documentation only** (no migrations, no views/materialized views created, no ORM models, no runtime implementation).

## Scope

Derivations covered:
- On-hand per `(item_id, location_id, uom)`
- Segmented on-hand (e.g., QC hold vs available) based on location policy
- Pipeline quantities from purchasing/receiving documents (ordered, received-not-putaway, etc.)

Out of scope for this feature doc:
- Reservations/allocations, pick/pack/ship commitments.
- Costing/valuation.
- Demand forecasting.

## Source of Truth (Phase 2)

- **Inventory movements** are authoritative for inventory deltas and physical stock transitions (Phase 0 Feature 1).
- **Receipts/QC/putaway documents** are authoritative for operational status and pipeline/position reporting (Phase 1 Features 1–4).

If documents and movements disagree, treat it as an integrity error to be surfaced, not silently reconciled.

## Canonical Dimensions

All inventory quantities must be computed per:
- `item_id`
- `location_id`
- `uom`

No unit conversions are performed; mixed-UOM is never summed together.

## Documented Computations (Logical)

### 1) On-hand (ledger-derived)

For any `(item_id, location_id, uom)`:
- `on_hand_qty = sum(quantity_delta)` across `inventory_movement_lines` whose parent movement is `posted`.

Pseudo-query:
```sql
select
  l.item_id,
  l.location_id,
  l.uom,
  coalesce(sum(l.quantity_delta), 0) as on_hand_qty
from inventory_movement_lines l
join inventory_movements m on m.id = l.movement_id
where m.status = 'posted'
group by l.item_id, l.location_id, l.uom;
```

Notes:
- Negative on-hand is permitted by the ledger model (Phase 0 Feature 1).
- Transfer invariants and sign rules are posting-time validations (not DB constraints).

As-of variant:
On-hand can optionally be derived as of a timestamp using `where m.status = 'posted' and m.occurred_at <= :as_of`. The non–as-of form is equivalent to `as_of = now()`.

### 2) Location disposition segmentation (policy-derived)

Inventory position often needs segmentation (e.g., “available” vs “QC hold”).
Phase 2 assumes segmentation is defined by **location policy**, not embedded in the movement lines.

Documented policy examples:
- Locations designated as QC hold/quarantine contribute to `qc_hold_qty`.
- Other storage locations contribute to `available_qty`.

In practice this requires an implementation-time mapping like:
- A configured set of QC hold `location_id`s, or
- A `locations.type`/classification rule (if introduced later).

Phase 2 documents the computation shape only:
- `available_qty = sum(on_hand_qty where location is available)`
- `qc_hold_qty = sum(on_hand_qty where location is qc_hold)`

### 3) On-order (purchasing pipeline)

For each PO line `(purchase_order_lines.id)`:
- `qty_ordered = purchase_order_lines.quantity_ordered`
- `qty_received_doc = sum(purchase_order_receipt_lines.quantity_received)` (document-level received)
- `qty_open = qty_ordered - qty_received_doc`

Aggregate per `(item_id, uom)` (and optionally vendor):
- `on_order_qty = sum(max(qty_open, 0))` across PO lines whose parent PO is not canceled/closed.

Phase 2 treats `on_order_qty` as an `(item_id, uom)` pipeline bucket (not location-specific) unless the system later chooses to allocate on-order to a specific site/DC based on `purchase_orders.ship_to_location_id` or similar policy.
PO lines whose parent PO is `closed` are excluded from `on_order_qty` even if `qty_open > 0`, because `closed` is administrative termination of further receipts (Phase 1 Feature 1).

Posting-time validation boundary:
- Receipts are authoritative for PO progress; movements are authoritative for on-hand.

### 4) Inbound not yet available (receiving/QC/putaway pipeline)

Depending on operational reporting needs, “inventory position” can include pipeline buckets derived from Phase 1 documents:

- **Received, awaiting QC disposition**
  - Receipt lines with `qc_status in ('pending','held')` contribute to `qc_pending_qty` (document bucket).

- **Accepted, awaiting putaway**
  - If using the Phase 1 Feature 2 two-step strategy (receive into QC hold then transfer on release), then:
    - “Accepted but not yet put away” is best represented by **location segmentation** (released into a staging/available-but-not-putaway location) or by putaway documents.
  - If putaway documents exist:
    - `putaway_open_qty` can be derived from `putaway_lines` where `status='pending'` grouped by `(item_id, uom, from_location_id)`.

Important: these are **operational buckets**, not inventory authority. They are derived from documents and should reconcile to movements via posting-time validations and linkages.
Pipeline buckets should be reconcilable to ledger movements via linkages and posting-time validations, but they are not required to sum to on-hand at every moment (e.g., drafts/unposted docs).

## Optional Read-Model Schemas (Phase 2, Docs Only)

These are optional for performance and reporting. They must always be reconcilable to the ledger/documents.

### `inventory_balances` (optional)

Denormalized on-hand per `(item_id, location_id, uom)`; can be a view or materialized table in later implementation.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `item_id` | `uuid` | no | |
| `location_id` | `uuid` | no | |
| `uom` | `text` | no | |
| `on_hand_qty` | `numeric(18,6)` | no | derived |
| `computed_at` | `timestamptz` | no | when computed/materialized |

Constraints / indexes (if materialized later):
- `primary key (item_id, location_id, uom)`
- `index (location_id, item_id)`

### `inventory_position` (optional)

Roll-up per `(item_id, uom)` with segmented quantities.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `item_id` | `uuid` | no | |
| `uom` | `text` | no | |
| `available_qty` | `numeric(18,6)` | no | policy-derived from `inventory_balances` |
| `qc_hold_qty` | `numeric(18,6)` | no | policy-derived from `inventory_balances` |
| `on_order_qty` | `numeric(18,6)` | no | derived from PO/receipts |
| `computed_at` | `timestamptz` | no | |

Constraints / indexes (if materialized later):
- `primary key (item_id, uom)`

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines on-hand as the sum of posted movement deltas per `(item_id, location_id, uom)` and includes a pseudo-query.
2. Documentation defines inventory position buckets (at minimum: available vs QC hold vs on-order) and clearly labels which are ledger-derived vs document-derived.
3. Documentation states the UOM aggregation rule (no mixed-UOM summation; no conversions).
4. Documentation specifies optional read-model schemas (`inventory_balances`, `inventory_position`) as docs-only with column definitions.
5. No production code is added (no views/materialized views created, no migrations, no runtime implementation).
