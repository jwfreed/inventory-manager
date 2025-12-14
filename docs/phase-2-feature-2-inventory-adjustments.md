# Phase 2 — Feature 2: Inventory Adjustments (Ledger-Correcting Movements) — Schemas + Acceptance Criteria Only

This document defines the **schemas** and **documented posting-time validations** for inventory adjustments as ledger-correcting movements.
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Creating adjustments to correct on-hand quantities (positive or negative deltas).
- Capturing adjustment reasons and audit metadata.
- Linking adjustments to inventory movements of type `adjustment` (Phase 0 Feature 1).

Out of scope:
- Count workflows that compute deltas from counted quantities (stocktake UX).
- Cost/valuation implications.
- Approvals/RBAC.

## Conceptual Model

### Adjustments Are Corrections, Not Mutations

- Inventory is authoritative in the movement ledger.
- Adjustments are new ledger entries that correct prior mistakes; they do not edit history.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `inventory_adjustments`

Document header for an adjustment transaction. The inventory effect is represented by a linked `inventory_movement` of type `adjustment`.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `occurred_at` | `timestamptz` | no | Business-effective time |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected `movement_type='adjustment'` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `check (status in ('draft','posted','canceled'))`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `unique (inventory_movement_id)` (one adjustment doc per movement)
- `index (status, occurred_at)`

### `inventory_adjustment_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `inventory_adjustment_id` | `uuid` | no | FK → `inventory_adjustments(id)` |
| `line_number` | `integer` | no | 1-based; unique per adjustment |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `location_id` | `uuid` | no | FK → `locations(id)` |
| `uom` | `text` | no | No conversions in Phase 2 |
| `quantity_delta` | `numeric(18,6)` | no | May be positive or negative; must be non-zero |
| `reason_code` | `text` | no | Controlled vocabulary recommended (e.g., `damage`, `shrink`, `found`, `data_correction`) |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (inventory_adjustment_id) references inventory_adjustments(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (location_id) references locations(id)`
- `check (quantity_delta <> 0)`
- `unique (inventory_adjustment_id, line_number)`
- `index (item_id, location_id, uom)`
- `index (reason_code)` (optional)

### `inventory_adjustment_reason_codes` (Optional, Docs Only)

Optional lookup table to formalize reason codes (implementation may instead use constants).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `code` | `text` | no | PK |
| `description` | `text` | no | |
| `active` | `boolean` | no | default true |

## Posting-Time Validations (Documented)

### Adjustment posting vs movement posting

Posting-time validation (application/service layer):
- An `inventory_adjustment` may exist in `draft` with `inventory_movement_id = NULL`.
- An adjustment is considered **posted/effective** only when:
  - `inventory_adjustments.status='posted'`, and
  - it is linked to a `posted` `inventory_movement` with `movement_type='adjustment'`.

Atomic posting (Phase 2): posting an adjustment is atomic— the adjustment status transition to `posted` and the linked movement’s posting occur together (all-or-nothing).

Cancel policy (Phase 2): `canceled` is intended for draft-only invalidation; canceling a posted adjustment must be done via a new compensating adjustment (new movement), not by removing or “unposting” the linked movement.

Posting-time validation: the linked `inventory_movements.occurred_at` must equal `inventory_adjustments.occurred_at` (no drift) to keep time-series reporting consistent.

### Line ↔ movement correspondence

Posting-time validation:
- Each `inventory_adjustment_lines` row must correspond to an `inventory_movement_line` with matching:
  - `(item_id, location_id, uom, quantity_delta)`
- Movement lines must have `quantity_delta <> 0` and may be either sign (consistent with adjustment semantics).

### Negative on-hand policy boundary

Phase 0 permits negative on-hand. Posting-time validation may optionally enforce a stricter policy (later phase):
- Disallow posting adjustments that would take any `(item, location, uom)` below zero (except configured virtual locations), or
- Allow negatives but log/audit warnings.

## Acceptance Criteria (Schemas Only)

1. Documentation defines `inventory_adjustments` and `inventory_adjustment_lines` schemas with statuses, timing, and line-level deltas.
2. Documentation defines linkage to `inventory_movements` of type `adjustment` without implementing it.
3. Documentation defines posting-time validations for “posted/effective” and line-to-movement correspondence.
4. Documentation defines adjustment reason capture (reason_code) and optionally a reason-code lookup schema.
5. No production code is added (no migrations executed, no ORM/runtime model implementation).
