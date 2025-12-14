# Phase 3 — Feature 2: Work Orders (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for manufacturing work orders.
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Creating work orders to produce an output item using a BOM version (Phase 3 Feature 1).
- Planning a target output quantity and tracking work order status.
- Recording execution results (component consumption + output production) as inventory movements.

Out of scope (Phase 3 Feature 2):
- Detailed routing/operations, labor tracking, equipment scheduling.
- Lot/serial tracking.
- Costing/variance cost accounting.

## Conceptual Model

### Work Order as the Manufacturing Document

- The work order is the business document representing intent and execution.
- Inventory authority remains the ledger (Phase 0 Feature 1):
  - Component consumption is represented as negative deltas (typically `issue` or `adjustment` per policy).
  - Output production is represented as positive deltas (typically `receive` or `adjustment` per policy).
  - If you want a single balanced transaction, use a policy of paired movements (or a future `manufacture` movement type); Phase 3 documents linkages only.
  - Movement type selection for consumption/production (e.g., `issue`/`receive` vs `adjustment`) is an implementation-time policy; regardless, the sign and location semantics must match the execution lines.

### UOM Assumption

- No unit conversions.
- All computations and validations are per `(item_id, uom)`.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `work_orders`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_number` | `text` | no | Unique business identifier |
| `status` | `text` | no | enum-like: `draft`, `released`, `in_progress`, `completed`, `canceled` |
| `bom_id` | `uuid` | no | FK → `boms(id)` |
| `bom_version_id` | `uuid` | yes | FK → `bom_versions(id)`; resolved at release time if not set |
| `output_item_id` | `uuid` | no | FK → `items(id)`; should match BOM output |
| `output_uom` | `text` | no | Should match BOM default/yield UOM |
| `quantity_planned` | `numeric(18,6)` | no | Must be > 0 |
| `quantity_completed` | `numeric(18,6)` | yes | >= 0; updated as execution posts |
| `scheduled_start_at` | `timestamptz` | yes | |
| `scheduled_due_at` | `timestamptz` | yes | |
| `released_at` | `timestamptz` | yes | |
| `completed_at` | `timestamptz` | yes | |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (work_order_number)`
- `check (status in ('draft','released','in_progress','completed','canceled'))`
- `check (quantity_planned > 0)`
- `check (quantity_completed is null or quantity_completed >= 0)`
- `foreign key (bom_id) references boms(id)`
- `foreign key (bom_version_id) references bom_versions(id)`
- `foreign key (output_item_id) references items(id)`
- `index (status)`
- `index (bom_id, bom_version_id)`

### `work_order_material_requirements`

Optional planned component requirements computed from the BOM at release time (snapshot of recipe requirements).
`work_order_material_requirements` is advisory/planning data and does not drive inventory; execution lines + movements are authoritative for what was actually consumed/produced.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_id` | `uuid` | no | FK → `work_orders(id)` |
| `line_number` | `integer` | no | unique per work order |
| `component_item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `quantity_required` | `numeric(18,6)` | no | > 0 |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_id) references work_orders(id)`
- `foreign key (component_item_id) references items(id)`
- `unique (work_order_id, line_number)`
- `check (quantity_required > 0)`
- `index (work_order_id)`

### `work_order_executions`

Represents an atomic execution/posting event (e.g., one production report). Multiple executions may occur per work order.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_id` | `uuid` | no | FK → `work_orders(id)` |
| `occurred_at` | `timestamptz` | no | Effective time of the execution |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `consumption_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; component deltas |
| `production_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; output deltas |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_id) references work_orders(id)`
- `foreign key (consumption_movement_id) references inventory_movements(id)`
- `foreign key (production_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `unique (consumption_movement_id)` (optional)
- `unique (production_movement_id)` (optional)
- `index (work_order_id, occurred_at)`

### `work_order_execution_lines`

Records the quantities consumed/produced for an execution event.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_execution_id` | `uuid` | no | FK → `work_order_executions(id)` |
| `line_type` | `text` | no | enum-like: `consume`, `produce` |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | |
| `quantity` | `numeric(18,6)` | no | Must be > 0 |
| `from_location_id` | `uuid` | yes | For consumption lines |
| `to_location_id` | `uuid` | yes | For production lines |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_execution_id) references work_order_executions(id)`
- `foreign key (item_id) references items(id)`
- `foreign key (from_location_id) references locations(id)`
- `foreign key (to_location_id) references locations(id)`
- `check (line_type in ('consume','produce'))`
- `check (quantity > 0)`
- `index (work_order_execution_id)`
- `index (item_id)`

## Posting-Time Validations (Documented)

### Release semantics

Posting-time validation (application/service layer):
- On `draft` → `released`, the system resolves and locks a `bom_version_id` (either already set or selected as the active effective version).
- `work_orders.output_item_id` must match the BOM output item.
- `output_uom` must match the BOM output UOM; no conversions.

### Execution posting (atomic)

Posting-time validation:
- A work order execution may be created as `draft` with no linked movements.
- Posting is atomic (all-or-nothing):
  - `work_order_executions.status` transitions to `posted`, and
  - linked inventory movement(s) are posted to reflect consumption/production deltas.

Cancel policy: `canceled` is draft-only for executions. Once an execution is posted, it cannot be canceled or edited; corrections require a new compensating execution and corresponding movements.

### Movement correspondence

Posting-time validation:
- For `consume` lines, `from_location_id` must be non-null and `to_location_id` must be null.
- For `produce` lines, `to_location_id` must be non-null and `from_location_id` must be null.
- Consumption execution lines must correspond to negative ledger deltas from `from_location_id` for the same `(item_id, uom)`.
- Production execution lines must correspond to positive ledger deltas into `to_location_id` for the same `(item_id, uom)`.
- Movement `occurred_at` must equal `work_order_executions.occurred_at`.

### Status transitions

Posting-time validation:
- `released` → `in_progress`: allowed when first execution is created (or explicitly by user action).
- `in_progress` → `completed`: allowed by explicit user action when no further executions are expected; `completed_at` set.
- `canceled` is intended for draft-only invalidation of work orders; canceling a completed work order is out of scope and should be handled by compensating executions/adjustments.

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for `work_orders`, `work_order_material_requirements`, `work_order_executions`, and `work_order_execution_lines`.
2. Documentation defines linkage to BOM versions (resolved/locked at release time) and to inventory movements for consumption/production.
3. Documentation defines posting-time validations for release, atomic execution posting, movement correspondence, and status transitions.
4. No production code is added (no migrations executed, no ORM/runtime model implementation).
