# Phase 3 — Feature 3: Material Issue vs Backflush Policy (Schemas + Acceptance Criteria Only)

This document defines **schemas** and **posting-time validations (documented)** for material consumption policy:
- **Manual issue** (explicit component issues)
- **Backflush** (automatic component consumption based on production quantity and BOM)

It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Defining a policy for how component consumption is recorded for a work order.
- Capturing explicit material issue transactions (when policy is manual issue).
- Capturing backflush configuration and the derived consumption quantities (when policy is backflush).

Out of scope (Phase 3 Feature 3):
- Picking/warehouse task management.
- Lot/serial selection rules.
- Costing/variance cost accounting.

## Conceptual Model

### Authority and Invariants

- Inventory authority remains the ledger (Phase 0 Feature 1).
- Work order executions are the manufacturing document of record (Phase 3 Feature 2).
- This feature defines *how* component consumption quantities are determined and recorded, not a new inventory mechanism.

### Policy Definitions

- **Manual issue**: consumption is recorded only via explicit issue transactions (user/system posts component deltas).
- **Backflush**: consumption is derived from BOM requirements and production quantity at execution posting time.
  - Backflush does not remove the need for inventory movements; it determines the quantities posted.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `work_orders` (Extension)

Adds a policy field to the Phase 3 Feature 2 `work_orders` table.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `material_consumption_policy` | `text` | no | enum-like: `manual_issue`, `backflush` |

Constraints / indexes:
- `check (material_consumption_policy in ('manual_issue','backflush'))`

### `work_order_material_issues`

Represents an explicit component issue transaction for a work order (manual issue workflow).
Multiple issues may occur per work order.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_id` | `uuid` | no | FK → `work_orders(id)` |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `occurred_at` | `timestamptz` | no | Effective time |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; expected component deltas |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (work_order_id) references work_orders(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `unique (inventory_movement_id)` (optional; one doc per movement)
- `index (work_order_id, occurred_at)`

### `work_order_material_issue_lines`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_material_issue_id` | `uuid` | no | FK → `work_order_material_issues(id)` |
| `line_number` | `integer` | no | 1-based; unique per issue |
| `component_item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions in Phase 3 |
| `quantity_issued` | `numeric(18,6)` | no | Must be > 0 |
| `from_location_id` | `uuid` | no | FK → `locations(id)` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_material_issue_id) references work_order_material_issues(id)`
- `foreign key (component_item_id) references items(id)`
- `foreign key (from_location_id) references locations(id)`
- `check (quantity_issued > 0)`
- `unique (work_order_material_issue_id, line_number)`
- `index (component_item_id)`

### `work_order_backflush_events`

Represents a single backflush computation and posting event, typically tied to a posted production execution.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_execution_id` | `uuid` | no | FK → `work_order_executions(id)` |
| `status` | `text` | no | enum-like: `draft`, `posted`, `canceled` |
| `occurred_at` | `timestamptz` | no | Must match execution occurred_at |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)`; consumption deltas |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_execution_id) references work_order_executions(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (status in ('draft','posted','canceled'))`
- `unique (work_order_execution_id)` (one backflush event per execution)
- `unique (inventory_movement_id)` (optional)
- `index (occurred_at)`

### `work_order_backflush_lines`

Computed component consumption results for a backflush event.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_backflush_event_id` | `uuid` | no | FK → `work_order_backflush_events(id)` |
| `line_number` | `integer` | no | unique per backflush event |
| `component_item_id` | `uuid` | no | FK → `items(id)` |
| `uom` | `text` | no | No conversions in Phase 3 |
| `quantity_to_consume` | `numeric(18,6)` | no | Must be > 0 |
| `from_location_id` | `uuid` | yes | Component source location (policy-defined; may be required later) |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_backflush_event_id) references work_order_backflush_events(id)`
- `foreign key (component_item_id) references items(id)`
- `foreign key (from_location_id) references locations(id)`
- `check (quantity_to_consume > 0)`
- `unique (work_order_backflush_event_id, line_number)`

## Documented Computations

### Backflush quantity derivation

For a posted `work_order_execution` with produced quantity `Q` (in output UOM):

For each BOM component line:
- `component_per_output_unit = component_quantity / yield_quantity`
- `quantity_to_consume = component_per_output_unit * Q`
- Apply `scrap_factor` if used (Phase 3 Feature 1).

No unit conversions are performed.
Rounding policy is applied at execution/posting time (not in BOM definition).

## Posting-Time Validations (Documented)

### Policy enforcement

Posting-time validation (application/service layer):
- If `work_orders.material_consumption_policy='manual_issue'`:
  - Backflush posting is not allowed.
  - Component consumption must be represented by posted `work_order_material_issues` and/or work order execution consumption movements.
- If `work_orders.material_consumption_policy='backflush'`:
  - Explicit manual issue may be allowed only as an exception policy (e.g., for substitutions), but must be audited; default is to derive consumption via backflush.
  - Default rule: when `material_consumption_policy='backflush'`, manual issue documents are rejected at posting time unless an exception reason (or equivalent audited flag) is provided (implementation-time policy; schema out of scope).

### Atomic posting and cancel semantics

Posting-time validation:
- Material issue posting is atomic with the linked movement posting.
- Backflush event posting is atomic with the linked movement posting and the parent execution posting.
- `canceled` is intended for draft-only invalidation; posted material issues/backflush events are corrected via compensating documents/movements, not “unposting”.

### Line ↔ movement correspondence

Posting-time validation:
- Material issue lines must correspond to negative ledger deltas from `from_location_id` for the same `(component_item_id, uom)` at `occurred_at`.
- Backflush lines must correspond to negative ledger deltas for the same `(component_item_id, uom)` at `occurred_at`.

Backflush source-location policy (Phase 3): component consumption must draw from a policy-defined source location (e.g., the execution’s `from_location_id`, a configured “point-of-use” location, or a designated staging location). If no policy resolves a source location, backflush posting must fail.

### Double-consumption prevention

Posting-time validation:
- Double-consumption prevention keys on `work_order_execution_id`: at most one of (a) posted execution consume movements, (b) posted backflush event for that execution, unless an explicit exception policy is invoked and audited.
- For a given execution event, do not post both:
  - explicit consumption movements (execution consume lines), and
  - backflush consumption movements
  unless an explicit exception policy exists and is audited.

## Acceptance Criteria (Schemas Only)

1. Documentation defines a `material_consumption_policy` on `work_orders` with `manual_issue` vs `backflush`.
2. Documentation defines schemas for explicit material issue documents (`work_order_material_issues`, `work_order_material_issue_lines`) and their linkage to inventory movements.
3. Documentation defines schemas for backflush events (`work_order_backflush_events`, `work_order_backflush_lines`) tied to work order executions and inventory movements.
4. Documentation defines backflush quantity computations derived from BOM yield-based requirements and produced quantities.
5. Documentation defines posting-time validations for policy enforcement, atomic posting, cancel semantics, and double-consumption prevention.
6. No production code is added (no migrations executed, no ORM/runtime model implementation).
