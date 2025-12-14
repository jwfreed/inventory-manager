# Phase 4 — Feature 4: Pick / Pack / Ship Execution Docs (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for pick/pack/ship execution documents.
It is **documentation only** (no migrations, no OMS/WMS runtime implementation, no production code).

## Scope

Supports:
- Creating pick tasks for sales order demand.
- Recording packed quantities and packing groupings.
- Posting shipments (already modeled at a high level in Phase 4 Feature 1) as the execution outcome.
- Linking execution docs to reservations (Phase 4 Feature 3) and to inventory movements (Phase 0 Feature 1).

Out of scope (Phase 4 Feature 4):
- Optimization/wave planning.
- Carrier rating/label purchase.
- Lot/serial picking.

## Conceptual Model

### Document Layers

- **Pick**: intent + execution of removing items from a storage location.
- **Pack**: grouping picked items into packages/containers.
- **Ship**: the final fulfillment event; inventory is decremented via an `issue` movement.

Inventory authority remains the movement ledger. Execution docs are operational records.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `pick_batches`

Represents a unit of pick work (may cover one or more sales orders).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `draft`, `released`, `in_progress`, `completed`, `canceled` |
| `pick_type` | `text` | no | enum-like: `single_order`, `batch` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `check (status in ('draft','released','in_progress','completed','canceled'))`
- `check (pick_type in ('single_order','batch'))`
- `index (status)`

### `pick_tasks`

A pick task targets a specific sales order line reservation at a specific location.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `pick_batch_id` | `uuid` | no | FK → `pick_batches(id)` |
| `status` | `text` | no | enum-like: `pending`, `picked`, `short`, `canceled` |
| `inventory_reservation_id` | `uuid` | yes | FK → `inventory_reservations(id)`; preferred linkage |
| `sales_order_line_id` | `uuid` | yes | FK → `sales_order_lines(id)`; allowed if no reservation model is used |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `from_location_id` | `uuid` | no | FK → `locations(id)` |
| `quantity_requested` | `numeric(18,6)` | no | Must be > 0 |
| `quantity_picked` | `numeric(18,6)` | yes | >= 0 |
| `picked_at` | `timestamptz` | yes | |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (pick_batch_id) references pick_batches(id)`
- `foreign key (inventory_reservation_id) references inventory_reservations(id)`
- `foreign key (sales_order_line_id) references sales_order_lines(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (from_location_id) references locations(id)`
- `check (status in ('pending','picked','short','canceled'))`
- `check (quantity_requested > 0)`
- `check (quantity_picked is null or quantity_picked >= 0)`
- `index (pick_batch_id, status)`
- `index (inventory_reservation_id)` (optional)
- `index (sales_order_line_id)` (optional)

### `packs`

Represents a packing unit (box, pallet, tote) within a shipment.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `open`, `sealed`, `canceled` |
| `sales_order_shipment_id` | `uuid` | no | FK → `sales_order_shipments(id)` |
| `package_ref` | `text` | yes | Box label / package identifier |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `check (status in ('open','sealed','canceled'))`
- `index (sales_order_shipment_id)`

### `pack_lines`

Assigns picked quantities into packs.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `pack_id` | `uuid` | no | FK → `packs(id)` |
| `pick_task_id` | `uuid` | yes | FK → `pick_tasks(id)`; traceability to pick |
| `sales_order_line_id` | `uuid` | no | FK → `sales_order_lines(id)` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `quantity_packed` | `numeric(18,6)` | no | Must be > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (pack_id) references packs(id)`
- `foreign key (pick_task_id) references pick_tasks(id)`
- `foreign key (sales_order_line_id) references sales_order_lines(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity_packed > 0)`
- `index (pack_id)`
- `index (sales_order_line_id)`

### `shipment_posts` (Optional, Docs Only)

If you want an explicit posting event document separate from `sales_order_shipments`:
- keep this optional in Phase 4 (docs-only).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `sales_order_shipment_id` | `uuid` | no | FK → `sales_order_shipments(id)` |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `occurred_at` | `timestamptz` | no | Must match shipment shipped_at |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; issue movement |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `unique (sales_order_shipment_id)` (optional; one post per shipment)

## Posting-Time Validations (Documented)

Pick cancel policy: pick batches/tasks may be canceled only if no downstream sealed packs or posted shipments exist; otherwise cancellation requires an audited exception and must not delete records.
Pack cancel policy: packs may be canceled only while `status='open'`; sealed packs require an explicit “reopen” or compensating pack record (policy).

### Pick task integrity

Posting-time validation (application/service layer):
- A pick task must be linked to either:
  - `inventory_reservation_id` (preferred), or
  - `sales_order_line_id` (if reservation model is not used),
  but not both.
- `quantity_picked` must be set when status becomes `picked`/`short`.
- `quantity_picked <= quantity_requested`, unless an over-pick exception is explicitly allowed and audited.
- If `pick_tasks.status='short'`, downstream packing/shipping must not exceed `quantity_picked`, and shipment lines must reflect the shortfall (partial shipment) rather than silently over-shipping.

### Pack integrity

Posting-time validation:
- Packed quantities must not exceed picked quantities per `(pick_task_id, item_id, uom)` unless an exception is allowed and audited.
- Pack status `sealed` prevents further edits.

### Shipment posting and movement linkage

Posting-time validation:
- A shipment is considered effective only when linked to a posted issue-type `inventory_movement` (Phase 4 Feature 1).
- Shipment movement lines must correspond to packed/shipped quantities by `(item_id, uom)` and negative deltas out of the shipment `ship_from_location_id`.
 - Shipment posted quantity is derived from `sales_order_shipment_lines` (authoritative for fulfillment), and must reconcile to `pack_lines` totals by `(sales_order_line_id, item_id, uom)` unless an audited exception is recorded.

### Reservation interaction (policy)

Posting-time validation:
- Picking/packing should not reduce on-hand; only shipment posting does.
- Reservations should be reduced/released as shipments post (policy-defined), not during picking.

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for pick batches and pick tasks, including linkage to reservations or SO lines, quantities, locations, and statuses.
2. Documentation defines schemas for packing (`packs`, `pack_lines`) linked to sales order shipments.
3. Documentation defines an optional `shipment_posts` schema as docs-only.
4. Documentation defines posting-time validations for pick/pack integrity, shipment movement linkage, and reservation interaction boundaries.
5. No production code is added (no migrations executed, no runtime implementation).
