# Phase 3 — Feature 4: WIP Tracking Model (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **documented computations** for tracking Work-In-Process (WIP) inventory.
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Representing WIP as inventory held in a designated WIP location (location-based WIP).
- Attributing WIP quantities to a specific work order for reporting (document-level attribution).
- Deriving WIP position from posted inventory movements and execution documents.

Out of scope (Phase 3 Feature 4):
- Costed WIP / valuation layers.
- Multi-operation routing with per-operation WIP buckets.
- Lot/serial WIP.

## Conceptual Model

### Two Complementary Views

1. **Physical WIP (ledger-based)**: quantities in a designated WIP location(s), derived from inventory movements.
2. **Attributed WIP (document-based)**: which work order “owns” the WIP, derived from work order execution documents and linkages.

Inventory authority remains the ledger (Phase 0 Feature 1). Attribution is a reporting layer.

### WIP Location Policy (Phase 3)

Phase 3 assumes WIP is represented using a designated WIP `location_id` (or a small set), selected via implementation-time policy (configured IDs, hardcoded codes, or classification rules introduced later).

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `work_orders` (Extension)

Adds optional WIP configuration to the Phase 3 Feature 2 `work_orders` table.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `wip_location_id` | `uuid` | yes | FK → `locations(id)`; designated physical WIP location for this WO |
| `wip_tracking_mode` | `text` | no | enum-like: `none`, `location_based` |

Constraints / indexes:
- `foreign key (wip_location_id) references locations(id)`
- `check (wip_tracking_mode in ('none','location_based'))`
- `index (wip_location_id)` (optional)

### `work_order_wip_events`

Optional append-only events that attribute WIP-relevant movement to a work order execution.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_execution_id` | `uuid` | no | FK → `work_order_executions(id)` |
| `event_type` | `text` | no | enum-like: `move_into_wip`, `move_out_of_wip` |
| `inventory_movement_id` | `uuid` | no | FK → `inventory_movements(id)`; expected posted |
| `occurred_at` | `timestamptz` | no | Must match movement occurred_at |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_execution_id) references work_order_executions(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (event_type in ('move_into_wip','move_out_of_wip'))`
- `unique (inventory_movement_id)` (one WO attribution per movement)
- `index (work_order_execution_id, occurred_at)`

### `work_order_wip_event_lines`

Line-level attribution for WIP moves (per item/location/uom).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_wip_event_id` | `uuid` | no | FK → `work_order_wip_events(id)` |
| `line_number` | `integer` | no | unique per WIP event |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions in Phase 3 |
| `quantity_delta` | `numeric(18,6)` | no | Non-zero; positive = into WIP, negative = out of WIP |
| `wip_location_id` | `uuid` | no | FK → `locations(id)`; should match `work_orders.wip_location_id` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_wip_event_id) references work_order_wip_events(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (wip_location_id) references locations(id)`
- `check (quantity_delta <> 0)`
- `unique (work_order_wip_event_id, line_number)`
- `index (item_id, wip_location_id, uom)`

## Documented Computations

### Physical WIP on-hand (ledger-derived)

For any `(item_id, wip_location_id, uom)`:
- `physical_wip_qty = sum(quantity_delta)` across posted movement lines at that location.

This is identical to standard on-hand derivation (Phase 2 Feature 1), restricted to WIP location(s).

### Attributed WIP per work order (event-derived)

For any `(work_order_id, item_id, wip_location_id, uom)`:
- `attributed_wip_qty = sum(work_order_wip_event_lines.quantity_delta)` across WIP events whose parent execution’s work order matches, and whose linked movements are posted.

Notes:
- Attribution must reconcile to physical WIP at the same location when summed across work orders, modulo drafts/unattributed movements and policy exceptions.
- No unit conversions; aggregate only matching UOM.

Attributed WIP is expected (not guaranteed) to reconcile to physical WIP; discrepancies are allowed when movements into/out of WIP are not attributed, are draft, or are intentionally excluded by policy.

## Posting-Time Validations (Documented)

### Event ↔ movement correspondence (atomic)

Posting-time validation (application/service layer):
- WIP events may exist only to attribute **posted** inventory movements.
- `work_order_wip_events.occurred_at` must equal `inventory_movements.occurred_at`.
- WIP event lines must correspond to the linked movement lines by `(item_id, uom, wip_location_id, quantity_delta)` sign and amount.

### WIP location requirement

Posting-time validation:
- If `work_orders.wip_tracking_mode='location_based'`, then `work_orders.wip_location_id` must be non-null.
- `work_order_wip_event_lines.wip_location_id` must equal the work order’s `wip_location_id` (no drift).

### Sign semantics

Posting-time validation:
- `event_type='move_into_wip'` implies net positive delta into the WIP location for the event (by `(item_id, uom)`).
- `event_type='move_out_of_wip'` implies net negative delta out of the WIP location.

### Immutability

- Posted WIP attribution is append-only; corrections are new events/movements (no edits).
- There is no “cancel” for WIP attribution; incorrect attribution is corrected via a new compensating WIP event (and/or compensating movement if the underlying movement was wrong).

## Acceptance Criteria (Schemas Only)

1. Documentation defines a location-based WIP model and states that physical quantities are ledger-derived from movements.
2. Documentation defines WIP configuration fields on `work_orders` (`wip_tracking_mode`, optional `wip_location_id`).
3. Documentation defines attribution schemas (`work_order_wip_events`, `work_order_wip_event_lines`) linking posted movements to work order executions.
4. Documentation defines computations for physical WIP and attributed WIP (per work order) and states the reconciliation expectation.
5. Documentation defines posting-time validations for movement correspondence, WIP location requirement, sign semantics, and append-only correction approach.
6. No production code is added (no migrations executed, no ORM/runtime model implementation).
