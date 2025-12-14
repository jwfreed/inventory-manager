# Phase 4 — Feature 3: Reservations / Allocations (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **documented computations/policies** for reservations/allocations.
It is **documentation only** (no migrations, no runtime allocation engine, no production code).

## Scope

Supports:
- Reserving inventory for demand (e.g., sales order lines) without moving inventory in the ledger.
- Tracking allocated quantities by item/location/UOM.
- Releasing reservations on cancel/close.
- Deriving available-to-promise (ATP-style) as `on_hand - reserved` (simplified).

Out of scope (Phase 4 Feature 3):
- Complex ATP with inbound supply matching and lead times.
- Picking/packing/shipping execution (beyond documents).
- Priority rules and optimization algorithms.

## Conceptual Model

### Reservations Are Not Movements

- Inventory movements remain the only authority for on-hand changes (Phase 0 Feature 1).
- Reservations/allocations are **constraints** on availability.
- When shipment occurs, inventory is decremented by an `issue` movement; reservations are reduced/released by policy, not by the movement itself (unless implementation chooses to couple them).

### Canonical Dimensions

All reservation quantities are tracked per:
- `item_id`
- `location_id`
- `uom`

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `inventory_reservations`

Represents a reservation of inventory for a demand document (e.g., a sales order line).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `open`, `released`, `fulfilled`, `canceled` |
| `demand_type` | `text` | no | enum-like: `sales_order_line` (Phase 4 baseline) |
| `demand_id` | `uuid` | no | Target demand entity id (e.g., `sales_order_lines.id`) |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `location_id` | `uuid` | no | FK → `locations(id)` |
| `uom` | `text` | no | No conversions in Phase 4 |
| `quantity_reserved` | `numeric(18,6)` | no | Must be > 0 |
| `quantity_fulfilled` | `numeric(18,6)` | yes | >= 0; updated as shipments consume reservation |
| `reserved_at` | `timestamptz` | no | default now() |
| `released_at` | `timestamptz` | yes | |
| `release_reason_code` | `text` | yes | e.g., `canceled`, `expired`, `reallocated` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `check (status in ('open','released','fulfilled','canceled'))`
- `check (demand_type in ('sales_order_line'))`
- `foreign key (item_id) references items(id)`
- `foreign key (location_id) references locations(id)`
- `check (quantity_reserved > 0)`
- `check (quantity_fulfilled is null or quantity_fulfilled >= 0)`
- `unique (demand_type, demand_id, item_id, location_id, uom)` (one reservation per demand+dimension; policy)
- `index (status)`
- `index (demand_type, demand_id)`
- `index (item_id, location_id, uom)`

### `inventory_allocations` (Optional, Docs Only)

If you want to separate “reservation intent” from “location-specific allocation”, this table can represent how a reservation is allocated across locations.
Phase 4 baseline can treat reservation == allocation and omit this.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `inventory_reservation_id` | `uuid` | no | FK → `inventory_reservations(id)` |
| `location_id` | `uuid` | no | FK → `locations(id)` |
| `uom` | `text` | no | |
| `quantity_allocated` | `numeric(18,6)` | no | Must be > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (inventory_reservation_id) references inventory_reservations(id)`
- `foreign key (location_id) references locations(id)`
- `check (quantity_allocated > 0)`
- `index (inventory_reservation_id)`

## Documented Computations

### Reserved quantity (open)

For any `(item_id, location_id, uom)`:
- `reserved_qty = sum(quantity_reserved - coalesce(quantity_fulfilled, 0))` over reservations with `status='open'`.

### Available quantity (simplified)

For any `(item_id, location_id, uom)`:
- `available_qty = on_hand_qty - reserved_qty`

Where `on_hand_qty` is derived from the movement ledger (Phase 2 Feature 1).

## Posting-Time Validations (Documented)

### Reservation creation

Posting-time validation (application/service layer):
- Reservations are created only for valid demand (Phase 4 baseline: existing `sales_order_lines.id`).
- `location_id` must be specified (Phase 4 uses location-specific reservations; global “any location” is out of scope).
- Phase 4 baseline expects at most one open reservation per demand line per `(item_id, location_id, uom)`; splitting across multiple reservations is out of scope unless `inventory_allocations` is implemented later.
- Before creating a reservation, the system should ensure (policy):
  - `available_qty >= quantity_reserved` for that `(item, location, uom)`, unless over-reservation is explicitly allowed and audited.
  - If over-reservation is allowed, require a reason in `notes` (or a dedicated reason code later) at posting time and emit an audit log entry.

### Fulfillment and release

Posting-time validation:
- Reservations are fulfilled by shipment posting (or associated fulfillment events):
  - When a shipment line posts, it may increase `quantity_fulfilled` on the matching reservation(s) (policy-defined matching).
- `status='fulfilled'` when `quantity_fulfilled >= quantity_reserved`.
- `released` indicates the reservation is no longer constraining availability (e.g., reallocated); `canceled` indicates demand canceled.
- Corrections are append-only in the sense that reservations should not be deleted; status changes and audit logs capture history.

Cancel policy: reservations are never deleted; `canceled`/`released` are allowed only while the reservation has no fulfilled quantity (or require an audited exception). If `quantity_fulfilled > 0`, changes must be append-only and fully audited.

### Authority boundaries

- Movements are authoritative for on-hand.
- Reservations are authoritative for reserved/available computations.
- If a shipment occurs without a reservation (or exceeds it), treat it as a policy exception and audit it.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines an `inventory_reservations` schema with demand linkage, item/location/UOM dimensions, quantities, and statuses.
2. Documentation defines optional `inventory_allocations` as docs-only and explains when it would be used.
3. Documentation defines computations for `reserved_qty` and `available_qty = on_hand - reserved`.
4. Documentation defines posting-time validations for reservation creation, fulfillment/release semantics, and authority boundaries.
5. No production code is added (no migrations executed, no runtime allocation engine, no ORM/runtime model implementation).
