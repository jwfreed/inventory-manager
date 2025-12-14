# Phase 1 — Feature 1: Purchase Orders (Schemas + Acceptance Criteria Only)

This document defines the **purchase order** domain schema for `inventory-manager`.
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Creating purchase orders (POs) to vendors/suppliers.
- Tracking ordered quantities per item and unit of measure.
- Receiving against a PO (partial/multiple receipts).
- Closing/canceling POs with an audit trail (via Phase 0 Feature 2 `audit_log`).

Out of scope (for this feature doc):
- Pricing/costing, taxes, landed cost.
- Vendor catalogs, lead times, replenishment planning.
- Serial/lot tracking.

## Core Concepts

### Purchase Order

- A PO is a request to a vendor to deliver items to a receiving location.
- A PO has one or more PO lines; each line defines an item, UOM, and ordered quantity.

### Receiving

- Receipts are recorded separately from the PO so you can support partial and repeated deliveries.
- Inventory effects are handled via Phase 0 Feature 1 inventory movements:
  - Receiving a PO creates (or is associated with) an `inventory_movement` of type `receive`.
  - This document only specifies the linkage, not the implementation.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `vendors`

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

Vendor master vs locations: `vendors` represents the business partner (supplier) master. It is distinct from any concept of “vendor locations” in the locations hierarchy (if introduced later). A vendor is a party; a location is a physical/logistical node.

### `purchase_orders`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `po_number` | `text` | no | Unique business identifier (human-facing) |
| `vendor_id` | `uuid` | no | FK → `vendors(id)` |
| `status` | `text` | no | enum-like: `draft`, `submitted`, `partially_received`, `received`, `closed`, `canceled` |
| `order_date` | `date` | yes | |
| `expected_date` | `date` | yes | |
| `ship_to_location_id` | `uuid` | yes | FK → `locations(id)`; where items should be received |
| `vendor_reference` | `text` | yes | Vendor’s acknowledgement/reference |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (vendor_id) references vendors(id)`
- `foreign key (ship_to_location_id) references locations(id)`
- `check (status in ('draft','submitted','partially_received','received','closed','canceled'))`
- `unique (po_number)`
- `index (vendor_id, status)`
- `index (created_at)`

### `purchase_order_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `purchase_order_id` | `uuid` | no | FK → `purchase_orders(id)` |
| `line_number` | `integer` | no | 1-based; unique per PO |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | Must match receipt UOM for aggregation; no conversions in Phase 1 |
| `quantity_ordered` | `numeric(18,6)` | no | Must be > 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (purchase_order_id) references purchase_orders(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity_ordered > 0)`
- `unique (purchase_order_id, line_number)`
- `index (purchase_order_id)`
- `index (item_id)`

### `purchase_order_receipts`

Represents a single receipt event (can be partial). Multiple receipts may exist per PO.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `purchase_order_id` | `uuid` | no | FK → `purchase_orders(id)` |
| `received_at` | `timestamptz` | no | Business effective time of receipt |
| `received_to_location_id` | `uuid` | yes | FK → `locations(id)`; defaults to PO `ship_to_location_id` |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected `movement_type='receive'` |
| `external_ref` | `text` | yes | Packing slip / ASN / delivery note |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (purchase_order_id) references purchase_orders(id)`
- `foreign key (received_to_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `index (purchase_order_id, received_at)`
- `index (inventory_movement_id)` (optional)

### `purchase_order_receipt_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `purchase_order_receipt_id` | `uuid` | no | FK → `purchase_order_receipts(id)` |
| `purchase_order_line_id` | `uuid` | no | FK → `purchase_order_lines(id)` |
| `uom` | `text` | no | Must equal PO line `uom` (no conversions) |
| `quantity_received` | `numeric(18,6)` | no | Must be > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (purchase_order_receipt_id) references purchase_order_receipts(id)`
- `foreign key (purchase_order_line_id) references purchase_order_lines(id)`
- `check (quantity_received > 0)`
- `index (purchase_order_receipt_id)`
- `index (purchase_order_line_id)`

## Derivations and Posting-Time Validations (Documented)

### Received quantity per PO line

For each `purchase_order_line_id`, total received is:
- Sum of `quantity_received` across all receipt lines.

This is aggregated per `(purchase_order_line_id, uom)`; mixed-UOM is not supported.

Posting-time validation: `purchase_order_receipt_lines.uom` must match the referenced `purchase_order_lines.uom`. This invariant is not enforceable via basic FK/check constraints and must be validated at posting time.

### Receipt ↔ Inventory movement linkage

Posting-time validation (application/service layer):
- Receipt posting vs movement posting (Phase 1): A `purchase_order_receipt` may exist in a draft/unposted document state with `inventory_movement_id = NULL`. A receipt is considered posted/effective only when it is linked to a posted `inventory_movement` (`movement_type='receive'`). Inventory on-hand is derived from the movement ledger, not from receipt rows.
- Phase 1 assumes a one-to-one relationship between a `purchase_order_receipt` and a receive-type `inventory_movement`; alternative mappings are out of scope.
- If `purchase_order_receipts.inventory_movement_id` is set, it must reference a `posted` `inventory_movement` with `movement_type='receive'`.
- Receipt line totals should correspond to the associated movement lines by `(item_id, uom)` and positive deltas into `received_to_location_id`.

Over-receipts: received quantity > ordered quantity are permitted at the ledger/document level unless explicitly blocked by application policy; enforcement decisions are deferred to later phases.

### PO status transitions (documented)

Posting-time validation (application/service layer):
closed semantics (Phase 1): `closed` is an administrative terminal state indicating the PO should no longer accept receipts. A PO may be closed even if not fully received (e.g., vendor short-ship, substitution, cancellation of remaining balance). If a stricter policy is desired (only allow `closed` after `received`), enforce it as a posting-time validation in implementation.
- `draft` → `submitted`: allowed only if the PO has ≥ 1 line.
- Receipt creation is allowed only when status is not `canceled`.
- Receipt location defaulting: if `received_to_location_id` is `NULL`, it defaults to the PO `ship_to_location_id`. If both are `NULL`, receipt creation must fail at posting time.
- Receipt location variance: `received_to_location_id` may differ from `purchase_orders.ship_to_location_id` (e.g., redirected delivery), provided it is a valid location. This does not change received-quantity derivations or status logic (statuses are driven by quantities received vs ordered). Any restriction that receipts must match `ship_to_location_id` is a posting-time policy (not a schema rule).
- After each receipt:
  - If no lines have any receipts: `submitted` (or `draft` if never submitted).
  - If some but not all quantities are received: `partially_received`.
  - If all line quantities are fully received: `received` (and may optionally move to `closed` via explicit user action).
- `received` → `closed`: allowed by explicit user action.
- `partially_received` → `closed`: allowed by explicit user action (administrative close).
- `canceled` means no further receipts may be recorded.

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for:
   - `vendors`
   - `purchase_orders`
   - `purchase_order_lines`
   - `purchase_order_receipts`
   - `purchase_order_receipt_lines`
2. Documentation defines PO lifecycle statuses and posting-time validations for:
   - status transitions
   - partial/multiple receipts
3. Documentation defines the receipt-to-inventory linkage via `inventory_movement_id` (without implementing it).
4. Documentation clarifies UOM expectations for PO lines and receipts (no unit conversions; must match).
5. No production code is added (no migrations executed, no ORM/runtime model implementation).
6. Documentation clarifies `closed` semantics, receipt posting vs movement posting, and enforcement boundaries (DB constraints vs posting-time validation).
