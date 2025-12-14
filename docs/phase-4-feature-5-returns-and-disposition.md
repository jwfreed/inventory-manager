# Phase 4 — Feature 5: Returns and Disposition (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for customer returns and downstream disposition.
It is **documentation only** (no migrations, no RMA runtime workflows, no production code).

## Scope

Supports:
- Recording return authorizations (RMAs) and return receipts.
- Receiving returned items into a returns/quarantine location.
- Dispositioning returns into: restock (available), scrap, refurbish/rework (future), or return-to-vendor (future).
- Linking return events to inventory movements that increment/decrement stock accordingly.

Out of scope (Phase 4 Feature 5):
- Refunds/credits and accounting.
- Lot/serial tracking.
- Detailed refurbish/rework execution (can integrate with Phase 3 later).

## Conceptual Model

### Returns Are Documents; Movements Are Inventory Authority

- Return documents describe customer-facing and operational return events.
- Inventory changes are represented by inventory movements (Phase 0 Feature 1).
- Returns should be append-only; corrections are compensating return events/movements (no edits/unposts).

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `return_authorizations`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `rma_number` | `text` | no | Unique business identifier |
| `customer_id` | `uuid` | no | FK → `customers(id)` |
| `sales_order_id` | `uuid` | yes | FK → `sales_orders(id)`; optional linkage |
| `status` | `text` | no | enum-like: `draft`, `authorized`, `closed`, `canceled` |
| `authorized_at` | `timestamptz` | yes | |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (rma_number)`
- `foreign key (customer_id) references customers(id)`
- `foreign key (sales_order_id) references sales_orders(id)`
- `check (status in ('draft','authorized','closed','canceled'))`
- `index (customer_id, status)`

### `return_authorization_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `return_authorization_id` | `uuid` | no | FK → `return_authorizations(id)` |
| `line_number` | `integer` | no | unique per RMA |
| `sales_order_line_id` | `uuid` | yes | FK → `sales_order_lines(id)`; optional linkage |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `quantity_authorized` | `numeric(18,6)` | no | Must be > 0 |
| `reason_code` | `text` | yes | e.g., `damaged`, `wrong_item`, `customer_remorse` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (return_authorization_id) references return_authorizations(id)`
- `foreign key (sales_order_line_id) references sales_order_lines(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity_authorized > 0)`
- `unique (return_authorization_id, line_number)`
- `index (item_id)`

### `return_receipts`

Represents a single return receipt event (partial/multiple receipts allowed).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `return_authorization_id` | `uuid` | no | FK → `return_authorizations(id)` |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `received_at` | `timestamptz` | no | Effective time |
| `received_to_location_id` | `uuid` | no | FK → `locations(id)`; returns/quarantine location |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected `movement_type='receive'` |
| `external_ref` | `text` | yes | Carrier tracking / package ref |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (return_authorization_id) references return_authorizations(id)`
- `foreign key (received_to_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `unique (inventory_movement_id)` (optional)
- `index (return_authorization_id, received_at)`

### `return_receipt_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `return_receipt_id` | `uuid` | no | FK → `return_receipts(id)` |
| `return_authorization_line_id` | `uuid` | yes | FK → `return_authorization_lines(id)`; optional linkage |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | Must match RMA line UOM if linked |
| `quantity_received` | `numeric(18,6)` | no | Must be > 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (return_receipt_id) references return_receipts(id)`
- `foreign key (return_authorization_line_id) references return_authorization_lines(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity_received > 0)`
- `index (return_receipt_id)`
- `index (item_id)`

### `return_dispositions`

Represents dispositioning returned goods from the returns location to a destination (restock/scrap/etc.).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `return_receipt_id` | `uuid` | no | FK → `return_receipts(id)` |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `occurred_at` | `timestamptz` | no | Effective time |
| `disposition_type` | `text` | no | enum-like: `restock`, `scrap`, `quarantine_hold` |
| `from_location_id` | `uuid` | no | FK → `locations(id)`; typically returns/quarantine |
| `to_location_id` | `uuid` | yes | FK → `locations(id)`; e.g., available storage, scrap |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected `transfer`/`issue` per policy |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (return_receipt_id) references return_receipts(id)`
- `foreign key (from_location_id) references locations(id)`
- `foreign key (to_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `check (disposition_type in ('restock','scrap','quarantine_hold'))`
- `unique (inventory_movement_id)` (optional)
- `index (return_receipt_id, occurred_at)`

### `return_disposition_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `return_disposition_id` | `uuid` | no | FK → `return_dispositions(id)` |
| `line_number` | `integer` | no | unique per disposition |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions |
| `quantity` | `numeric(18,6)` | no | Must be > 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (return_disposition_id) references return_dispositions(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity > 0)`
- `unique (return_disposition_id, line_number)`
- `index (item_id)`

## Posting-Time Validations (Documented)

### Receipt posting vs movement posting (atomic)

Posting-time validation (application/service layer):
- A return receipt may exist as `draft` with `inventory_movement_id = NULL`.
- A return receipt is considered posted/effective only when:
  - `return_receipts.status='posted'`, and
  - it is linked to a posted `inventory_movement` with `movement_type='receive'`.
- Posting is atomic: receipt status transition to `posted` and movement posting occur together.
- Phase 4 baseline: assume a one-to-one relationship between a posted `return_receipt` and a posted receive-type `inventory_movement`; bundling multiple docs into one movement is out of scope.
- Cancel policy: `canceled` is draft-only; posted receipts are corrected via compensating receipts/movements (no edits/unposts).

### Disposition posting vs movement posting (atomic)

Posting-time validation:
- A return disposition may exist as `draft` with `inventory_movement_id = NULL`.
- A disposition is posted/effective only when linked to a posted movement that implements the disposition:
  - `restock`: `transfer` returns → available location
  - `scrap`: `transfer` returns → scrap location (preferred) or `issue` from returns (policy-defined; must be consistent)
  - `quarantine_hold`: no movement (doc-only) or `transfer` returns → hold location (policy-defined; must be consistent)
- Posting is atomic with movement posting; cancel is draft-only; posted corrections are compensating.
Phase 4 baseline: assume a one-to-one relationship between a posted `return_disposition` and a posted inventory movement; bundling multiple docs into one movement is out of scope.

### Quantity integrity

Posting-time validation:
- Receipt lines should reconcile to movement lines by `(item_id, uom)` and positive deltas into `received_to_location_id`.
- Disposition lines must not exceed quantities available in the returns/quarantine location (ledger-derived on-hand at `from_location_id` per `(item_id, uom)` as of `occurred_at`), unless an exception is explicitly allowed and audited.
- If linked to RMA lines, receipt line `uom` must match the RMA line UOM (cross-table equality; posting-time validation).

### Location policy

Posting-time validation:
- `received_to_location_id` must be a policy-approved returns/quarantine location.
- For `restock`, `to_location_id` must be non-null and represent an available/storage location (policy-defined).

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for RMAs (`return_authorizations`, `return_authorization_lines`) and return receipts (`return_receipts`, `return_receipt_lines`).
2. Documentation defines schemas for return dispositions (`return_dispositions`, `return_disposition_lines`) including disposition types and location fields.
3. Documentation defines linkage to inventory movements for receipt and disposition without implementing it.
4. Documentation defines posting-time validations for atomic posting, cancel semantics, quantity integrity, and location policy.
5. No production code is added (no migrations executed, no ORM/runtime model implementation).
