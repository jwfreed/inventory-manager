# Phase 4 — Feature 1: Sales Orders (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for sales orders (SOs).
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Creating sales orders for customers.
- Tracking ordered quantities per item and UOM.
- Shipping against an SO (partial/multiple shipments).
- Closing/canceling SOs with an audit trail (via Phase 0 Feature 2 `audit_log`).

Out of scope (Phase 4 Feature 1):
- Reservations/allocations and ATP promises (may be Phase 4+).
- Pricing, taxes, invoicing, payments.
- Lot/serial tracking.

## Conceptual Model

### Sales Order

- An SO is a request to fulfill items to a customer from one or more fulfillment locations.
- An SO has one or more SO lines; each line defines an item, UOM, and ordered quantity.

### Shipping

- Shipments are recorded separately from the SO to support partial and repeated shipments.
- Inventory effects are handled via inventory movements (Phase 0 Feature 1):
  - Shipping creates (or is associated with) an `inventory_movement` of type `issue` (or a transfer to a customer location, depending on future policy).
  - This document only specifies the linkage, not the implementation.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `customers`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `code` | `text` | no | Unique business identifier |
| `name` | `text` | no | |
| `email` | `text` | yes | |
| `phone` | `text` | yes | |
| `active` | `boolean` | no | default true |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (code)`
- `index (active)`

Customer master vs locations: `customers` represents the business partner (ship-to party) master. It is distinct from any concept of customer locations in the locations hierarchy (if introduced later). A customer is a party; a location is a physical/logistical node.

### `sales_orders`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `so_number` | `text` | no | Unique business identifier (human-facing) |
| `customer_id` | `uuid` | no | FK → `customers(id)` |
| `status` | `text` | no | enum-like: `draft`, `submitted`, `partially_shipped`, `shipped`, `closed`, `canceled` |
| `order_date` | `date` | yes | |
| `requested_ship_date` | `date` | yes | |
| `ship_from_location_id` | `uuid` | yes | FK → `locations(id)`; default fulfillment site |
| `customer_reference` | `text` | yes | Customer PO / reference |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (customer_id) references customers(id)`
- `foreign key (ship_from_location_id) references locations(id)`
- `check (status in ('draft','submitted','partially_shipped','shipped','closed','canceled'))`
- `unique (so_number)`
- `index (customer_id, status)`
- `index (created_at)`

### `sales_order_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `sales_order_id` | `uuid` | no | FK → `sales_orders(id)` |
| `line_number` | `integer` | no | 1-based; unique per SO |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions in Phase 4 |
| `quantity_ordered` | `numeric(18,6)` | no | Must be > 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (sales_order_id) references sales_orders(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity_ordered > 0)`
- `unique (sales_order_id, line_number)`
- `index (sales_order_id)`
- `index (item_id)`

### `sales_order_shipments`

Represents a single shipment event (can be partial). Multiple shipments may exist per SO.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `sales_order_id` | `uuid` | no | FK → `sales_orders(id)` |
| `shipped_at` | `timestamptz` | no | Business effective time of shipment |
| `ship_from_location_id` | `uuid` | yes | FK → `locations(id)`; defaults to SO `ship_from_location_id` |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected `movement_type='issue'` |
| `external_ref` | `text` | yes | Carrier tracking / packing slip |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (sales_order_id) references sales_orders(id)`
- `foreign key (ship_from_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `index (sales_order_id, shipped_at)`
- `index (inventory_movement_id)` (optional)

### `sales_order_shipment_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `sales_order_shipment_id` | `uuid` | no | FK → `sales_order_shipments(id)` |
| `sales_order_line_id` | `uuid` | no | FK → `sales_order_lines(id)` |
| `uom` | `text` | no | Must equal SO line `uom` (no conversions) |
| `quantity_shipped` | `numeric(18,6)` | no | Must be > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `foreign key (sales_order_line_id) references sales_order_lines(id)`
- `check (quantity_shipped > 0)`
- `index (sales_order_shipment_id)`
- `index (sales_order_line_id)`

## Derivations and Posting-Time Validations (Documented)

### Shipped quantity per SO line

For each `sales_order_line_id`, total shipped is:
- Sum of `quantity_shipped` across all shipment lines.

This is aggregated per `(sales_order_line_id, uom)`; mixed-UOM is not supported.

Posting-time validation: `sales_order_shipment_lines.uom` must match the referenced `sales_order_lines.uom`. This invariant is not enforceable via basic FK/check constraints and must be validated at posting time.

### Shipment ↔ Inventory movement linkage

Posting-time validation (application/service layer):
- Shipment posting vs movement posting (Phase 4): A `sales_order_shipment` may exist in a draft/unposted document state with `inventory_movement_id = NULL`. A shipment is considered posted/effective only when it is linked to a posted `inventory_movement` (`movement_type='issue'`). Inventory on-hand is derived from the movement ledger, not from shipment rows.
- Authority split (Phase 4): shipments are authoritative for SO status and shipped quantities (SO progress derives from shipment rows), while inventory movements are authoritative for inventory on-hand. If shipments and movements disagree, treat it as an integrity error to be resolved by posting-time validation and audit.
- Phase 4 requires a one-to-one relationship between a `sales_order_shipment` and an issue-type `inventory_movement`; alternative mappings are out of scope. Each posted shipment must link to exactly one posted issue movement, and that movement must not be linked to any other shipment.
- If `sales_order_shipments.inventory_movement_id` is set, it must reference a `posted` `inventory_movement` with `movement_type='issue'`.
- Shipment line totals should correspond to the associated movement lines by `(item_id, uom)` and negative deltas out of `ship_from_location_id`.

Shipment cancel policy: a shipment may be canceled only while `inventory_movement_id` is `NULL` (draft). If linked to a posted movement, correction requires a compensating shipment record and compensating movement (no edits/unposts).

Over-shipments: shipped quantity > ordered quantity are permitted at the ledger/document level unless explicitly blocked by application policy; enforcement decisions are deferred to later phases.
If `quantity_shipped` causes any line to exceed `quantity_ordered`, require an over-ship reason in `notes` at posting time (policy) and emit an audit log entry.

### SO status transitions (documented)

Posting-time validation (application/service layer):
closed semantics (Phase 4): `closed` is an administrative terminal state indicating the SO should no longer accept shipments. An SO may be closed even if not fully shipped (e.g., customer cancellation of remaining balance). If a stricter policy is desired (only allow `closed` after `shipped`), enforce it as a posting-time validation in implementation.
- `draft` → `submitted`: allowed only if the SO has ≥ 1 line.
- Shipment creation is allowed only when status is not `canceled`.
- Shipment location defaulting: if `ship_from_location_id` is `NULL`, it defaults to the SO `ship_from_location_id`. If both are `NULL`, shipment creation must fail at posting time.
- Shipment location variance: `ship_from_location_id` may differ from `sales_orders.ship_from_location_id` (e.g., re-routed fulfillment), provided it is a valid location. This does not change shipped-quantity derivations or status logic (statuses are driven by quantities shipped vs ordered). Any restriction that shipments must match `ship_from_location_id` is a posting-time policy (not a schema rule).
- After each shipment:
  - If no lines have any shipments: `submitted` (or `draft` if never submitted).
  - If some but not all quantities are shipped: `partially_shipped`.
  - If all line quantities are fully shipped: `shipped` (and may optionally move to `closed` via explicit user action).
- `shipped` → `closed`: allowed by explicit user action.
- `partially_shipped` → `closed`: allowed by explicit user action (administrative close).
- `canceled` means no further shipments may be recorded.

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for:
   - `customers`
   - `sales_orders`
   - `sales_order_lines`
   - `sales_order_shipments`
   - `sales_order_shipment_lines`
2. Documentation defines SO lifecycle statuses and posting-time validations for:
   - status transitions
   - partial/multiple shipments
3. Documentation defines the shipment-to-inventory linkage via `inventory_movement_id` (without implementing it).
4. Documentation clarifies UOM expectations for SO lines and shipments (no unit conversions; must match).
5. No production code is added (no migrations executed, no ORM/runtime model implementation).
