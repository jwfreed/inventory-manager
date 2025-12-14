# Phase 1 — Feature 3: Putaway (Schemas + Acceptance Criteria Only)

This document defines the **schemas** for putaway: moving received inventory from a staging/QC area into final storage locations.
It is **documentation only** (no migrations, no triggers, no ORM models, no runtime implementation).

## Scope

Supports:
- Recording putaway work as a document (plan + execution).
- Capturing line-level moves from a source location to a destination location.
- Linking putaway to upstream receipt/QC context when available.

Out of scope (Phase 1 Feature 3):
- Directed putaway optimization (rules, capacity, slotting).
- Task assignment, picking/warehouse wave management.
- Serial/lot tracking.

## Conceptual Model

### Putaway as Movements + Documents

- Inventory effects occur via the inventory movement ledger (Phase 0 Feature 1), typically as `transfer` movements.
- Putaway documents exist to track intent and execution, separate from inventory authority.

Typical flow (documented, not implemented):
- Source is a staging location such as `RECEIVING` or `QC_HOLD`.
- Destination is a storage location such as a bin.
- When a putaway line is completed, it is linked to a posted `transfer` movement that moves quantity from source → destination.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `putaways`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `draft`, `in_progress`, `completed`, `canceled` |
| `source_type` | `text` | no | enum-like: `purchase_order_receipt`, `qc`, `manual` |
| `purchase_order_receipt_id` | `uuid` | yes | FK → `purchase_order_receipts(id)` when source_type is receipt |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `check (status in ('draft','in_progress','completed','canceled'))`
- `check (source_type in ('purchase_order_receipt','qc','manual'))`
- `foreign key (purchase_order_receipt_id) references purchase_order_receipts(id)`
- `index (status)`
- `index (purchase_order_receipt_id)` (optional)

### `putaway_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `putaway_id` | `uuid` | no | FK → `putaways(id)` |
| `line_number` | `integer` | no | 1-based; unique per putaway |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No unit conversion in Phase 1 |
| `quantity_planned` | `numeric(18,6)` | yes | Optional planned quantity (> 0) |
| `quantity_moved` | `numeric(18,6)` | yes | Quantity actually moved (> 0 when completed) |
| `from_location_id` | `uuid` | no | FK → `locations(id)` |
| `to_location_id` | `uuid` | no | FK → `locations(id)` |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected transfer, posted when effective |
| `status` | `text` | no | enum-like: `pending`, `completed`, `canceled` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (putaway_id) references putaways(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (from_location_id) references locations(id)`
- `foreign key (to_location_id) references locations(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `unique (putaway_id, line_number)`
- `check (status in ('pending','completed','canceled'))`
- `check (from_location_id <> to_location_id)`
- `index (putaway_id)`
- `index (inventory_movement_id)` (optional)
- `index (status)`

## Posting-Time Validations (Documented)

### Putaway document lifecycle

Posting-time validation (application/service layer):
- `draft` → `in_progress` is allowed only if the putaway has ≥ 1 line.
- `putaways.status='completed'` requires no line remains `pending` (all lines must be `completed` or `canceled`).
- `completed` means no further lines may be added/edited.
- `canceled` means no further actions may be recorded.

### Line completion vs movement posting

Posting-time validation:
- A `putaway_line` is considered **effective** only when:
  - `status='completed'`, and
  - it is linked to a `posted` `inventory_movement` with `movement_type='transfer'`.
- `putaway_lines.inventory_movement_id` cardinality (Phase 1): either one movement per line or a shared movement across multiple lines is acceptable. If shared, the movement must contain matching transfer deltas for each completed `putaway_line` (by `(item_id, uom, from_location_id, to_location_id, quantity_moved)`), and the movement must be posted atomically with those line completions.
- Putaway-from-QC policy (Phase 1): whether putaway is allowed while upstream QC is still `pending`/`held` is an application/service posting-time policy. If restricted, require QC to be effective (e.g., accepted/released) before completing putaway lines sourced from QC locations.
- Putaway inventory effects must be representable as balanced transfers (sum of deltas = 0) per the Phase 0 transfer invariants.

### Quantity rules

Posting-time validation:
- `quantity_moved` must be > 0 when completing a line.
- If `quantity_planned` is present, allow `quantity_moved` to differ (short putaway / over putaway) unless later policy blocks it.

### UOM rules

Posting-time validation:
- Putaway lines are aggregated and validated per `(item_id, uom)`; no conversions in Phase 1.
- If `source_type='qc'`, it indicates the source location is a QC hold/quarantine area; no direct FK to QC records is modeled in Phase 1.
- If a putaway is linked to receipt/QC context, putaway line `uom` must match the referenced receipt/QC line `uom` (no conversions).

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for `putaways` and `putaway_lines` with statuses, locations, items, quantities, and optional linkage to `inventory_movements`.
2. Documentation defines optional linkage from putaway to `purchase_order_receipts` (source context) without implementing workflow logic.
3. Documentation defines posting-time validations for document lifecycle, line completion, movement linkage, and quantity/UOM rules.
4. No production code is added (no migrations executed, no ORM/runtime model implementation).
