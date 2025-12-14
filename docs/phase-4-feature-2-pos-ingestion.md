# Phase 4 — Feature 2: POS Ingestion (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for ingesting Point-of-Sale (POS) transactions into `inventory-manager`.
It is **documentation only** (no migrations, no runtime ingestion pipeline, no production code).

## Scope

Supports:
- Ingesting POS sales/returns transactions from external systems.
- Idempotent ingestion (dedupe by source + external identifiers).
- Mapping POS line items to internal `items`.
- Linking POS transactions to inventory movements that decrement/increment stock.

Out of scope (Phase 4 Feature 2):
- Payment processing, tax calculation, pricing, discounts.
- Full sales accounting/journaling.
- Real-time inventory reservation.

## Conceptual Model

### POS as an External Event Stream

- POS ingestion records what happened in an external system.
- Inventory authority remains the movement ledger (Phase 0 Feature 1).
- POS events produce inventory effects only when posted/linked to posted movements.

### Transaction Types

Phase 4 models POS transactions at the “receipt” level with line items:
- `sale` (decrement on-hand)
- `return` (increment on-hand)
- `void` (document-only; inventory effect policy-defined, typically a compensating event rather than deleting history)

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `pos_sources`

Defines a distinct upstream POS integration source (e.g., “Shopify”, “Square Store #12”, “Lightspeed”).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `code` | `text` | no | Unique business identifier |
| `name` | `text` | no | |
| `active` | `boolean` | no | default true |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (code)`
- `index (active)`

### `pos_transactions`

Represents a single POS transaction (receipt).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `pos_source_id` | `uuid` | no | FK → `pos_sources(id)` |
| `external_transaction_id` | `text` | no | Idempotency key from source |
| `transaction_type` | `text` | no | enum-like: `sale`, `return`, `void` |
| `status` | `text` | no | enum-like: `ingested`, `posted`, `rejected` |
| `occurred_at` | `timestamptz` | no | Business time from POS |
| `store_location_id` | `uuid` | yes | FK → `locations(id)`; inventory location impacted (policy) |
| `currency` | `text` | yes | ISO code; informational only |
| `raw_payload` | `jsonb` | yes | Optional raw event payload for traceability |
| `notes` | `text` | yes | |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected issue/receive policy |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (pos_source_id) references pos_sources(id)`
- `foreign key (store_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `unique (pos_source_id, external_transaction_id)` (idempotent ingestion)
- `check (transaction_type in ('sale','return','void'))`
- `check (status in ('ingested','posted','rejected'))`
- `unique (inventory_movement_id)` (optional; enforce 1:1 link at implementation time)
- `index (pos_source_id, occurred_at)`
- `index (status, occurred_at)`

### `pos_transaction_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `pos_transaction_id` | `uuid` | no | FK → `pos_transactions(id)` |
| `line_number` | `integer` | no | 1-based; unique per transaction |
| `external_line_id` | `text` | yes | Source line identifier (if provided) |
| `external_sku` | `text` | yes | SKU as provided by POS |
| `item_id` | `uuid` | yes | FK → `items(id)`; resolved mapping when known |
| `uom` | `text` | no | No conversions in Phase 4 |
| `quantity` | `numeric(18,6)` | no | Must be > 0 |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (pos_transaction_id) references pos_transactions(id)`
- `foreign key (item_id) references items(id)`
- `check (quantity > 0)`
- `unique (pos_transaction_id, line_number)`
- `index (external_sku)` (optional)
- `index (item_id)` (optional)

### `pos_item_mappings` (Optional, Docs Only)

Optional mapping table for resolving POS-provided SKU identifiers to internal items.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `pos_source_id` | `uuid` | no | FK → `pos_sources(id)` |
| `external_sku` | `text` | no | |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `active` | `boolean` | no | default true |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (pos_source_id) references pos_sources(id)`
- `foreign key (item_id) references items(id)`
- `unique (pos_source_id, external_sku)`
- `index (active)`

## Posting-Time Validations (Documented)

### Idempotency and immutability

Posting-time validation (application/service layer):
- Ingestion is idempotent by `(pos_source_id, external_transaction_id)`.
- POS transactions are append-only; do not edit/delete ingested history. Corrections should arrive as new transactions (e.g., return/void) rather than mutation.

### Posting vs movement posting (atomic)

Posting-time validation:
- A `pos_transaction` may exist as `ingested` with `inventory_movement_id = NULL`.
- A POS transaction is considered **posted/effective** only when:
  - `pos_transactions.status='posted'`, and
  - it is linked to a `posted` inventory movement.
- Posting is atomic: status transition to `posted` and movement posting occur together.

Phase 4 assumes a one-to-one relationship between a posted `pos_transaction` and a posted `inventory_movement`; alternative mappings are out of scope.

### Movement linkage policy

Posting-time validation:
- `transaction_type='sale'` must link to a posted movement that decrements stock (typically `issue` from `store_location_id`).
- `transaction_type='return'` must link to a posted movement that increments stock (typically `receive` into `store_location_id`, or `adjustment` per policy). Return posting may increment stock into `store_location_id` or a policy-defined returns/quarantine location; if policy selects a different location, it must be explicit and auditable.
- `transaction_type='void'` has no direct inventory effect unless policy defines a compensating movement. `transaction_type='void'` must not delete or mutate prior posted POS history; if it has inventory impact, it must do so via a compensating movement (policy-defined).

### Location requirement

Posting-time validation:
- If the implementation expects inventory to move at posting, `store_location_id` must be non-null; otherwise posting must fail.

### Item/UOM matching

Posting-time validation:
- Each line must resolve to an `item_id` before posting inventory effects (or posting must fail / be rejected).
- No unit conversions; `uom` must be consistent for aggregation and movement line creation.

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for `pos_sources`, `pos_transactions`, and `pos_transaction_lines` including idempotency keys and required fields.
2. Documentation defines optional `pos_item_mappings` for SKU→item resolution (docs-only).
3. Documentation defines posting-time validations for idempotency, immutability, posting atomicity, movement linkage policy, and item/location requirements.
4. No production code is added (no migrations executed, no ingestion pipeline, no ORM/runtime model implementation).
