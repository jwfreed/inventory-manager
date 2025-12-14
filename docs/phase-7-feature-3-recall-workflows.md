# Phase 7 — Feature 3: Recall Execution Workflows (Schemas + Computations + Acceptance Criteria Only)

This document defines **schemas** and **documented computations** for recall execution workflows, building on:
- Traceability output sets (Phase 7 Feature 2)
- Disposition actions (Phase 4 Feature 5)
- Auditable recall case documents and communications tracking

It is **documentation only** (no migrations, no runtime workflow engine, no production code).

## Scope

Supports:
- Opening a recall case for one or more lots/items.
- Generating impacted sets (lots, shipments, customers) via forward trace.
- Recording actions taken (block/quarantine/scrap/restock) as auditable tasks and linked inventory movements where applicable.
- Tracking communications to customers and internal stakeholders.

Out of scope (Phase 7 Feature 3):
- Regulatory submission formats and integrations.
- Automated email/SMS sending (docs define tracking only).
- Legal/compliance review tooling.

## Authority and Data Sources

- Traceability results come from movement-lot joins (Phase 7 Feature 2).
- Returns/disposition movements are authoritative for inventory effects (Phase 4 Feature 5 + ledger).
- Recall case records are authoritative for “what the business decided and communicated”.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `recall_cases`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_number` | `text` | no | Unique business identifier |
| `status` | `text` | no | enum-like: `draft`, `active`, `closed`, `canceled` |
| `severity` | `text` | yes | enum-like: `low`, `medium`, `high`, `critical` |
| `initiated_at` | `timestamptz` | yes | |
| `closed_at` | `timestamptz` | yes | |
| `summary` | `text` | yes | Human summary |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (recall_number)`
- `check (status in ('draft','active','closed','canceled'))`
- `check (severity in ('low','medium','high','critical'))`
- `index (status, initiated_at)`

### `recall_case_targets`

Defines what is being recalled (lots and/or items).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_case_id` | `uuid` | no | FK → `recall_cases(id)` |
| `target_type` | `text` | no | enum-like: `lot`, `item` |
| `lot_id` | `uuid` | yes | FK → `lots(id)` when target_type=`lot` |
| `item_id` | `uuid` | yes | FK → `items(id)` when target_type=`item` |
| `uom` | `text` | yes | Optional filter; no conversions |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (recall_case_id) references recall_cases(id)`
- `foreign key (lot_id) references lots(id)`
- `foreign key (item_id) references items(id)`
- `check (target_type in ('lot','item'))`
- `unique (recall_case_id, target_type, lot_id, item_id, uom)`

### `recall_trace_runs`

Captures a trace computation snapshot for a recall case (results may change as ledger evolves; snapshots preserve what was used).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_case_id` | `uuid` | no | FK → `recall_cases(id)` |
| `as_of` | `timestamptz` | no | Trace snapshot boundary |
| `status` | `text` | no | enum-like: `computed`, `superseded` |
| `notes` | `text` | yes | |
| `computed_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (recall_case_id) references recall_cases(id)`
- `check (status in ('computed','superseded'))`
- `index (recall_case_id, computed_at)`

### `recall_impacted_shipments`

Stores impacted shipments derived from forward trace.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_trace_run_id` | `uuid` | no | FK → `recall_trace_runs(id)` |
| `sales_order_shipment_id` | `uuid` | no | FK → `sales_order_shipments(id)` |
| `customer_id` | `uuid` | no | FK → `customers(id)` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (recall_trace_run_id) references recall_trace_runs(id)`
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `foreign key (customer_id) references customers(id)`
- `unique (recall_trace_run_id, sales_order_shipment_id)`
- `index (customer_id)`

### `recall_impacted_lots` (Optional, Docs Only)

Stores impacted lots derived from forward/backward trace.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_trace_run_id` | `uuid` | no | FK → `recall_trace_runs(id)` |
| `lot_id` | `uuid` | no | FK → `lots(id)` |
| `role` | `text` | no | enum-like: `target`, `upstream_component`, `downstream_finished` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (recall_trace_run_id) references recall_trace_runs(id)`
- `foreign key (lot_id) references lots(id)`
- `check (role in ('target','upstream_component','downstream_finished'))`
- `unique (recall_trace_run_id, lot_id, role)`

### `recall_actions`

Tracks disposition/containment actions taken during recall execution.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_case_id` | `uuid` | no | FK → `recall_cases(id)` |
| `action_type` | `text` | no | enum-like: `block_lot`, `quarantine_lot`, `scrap_lot`, `restock_lot`, `customer_notify` |
| `status` | `text` | no | enum-like: `planned`, `in_progress`, `completed`, `canceled` |
| `lot_id` | `uuid` | yes | FK → `lots(id)` when action is lot-scoped |
| `sales_order_shipment_id` | `uuid` | yes | FK → `sales_order_shipments(id)` when customer-scoped |
| `inventory_movement_id` | `uuid` | yes | FK → `inventory_movements(id)` when action requires a movement |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (recall_case_id) references recall_cases(id)`
- `foreign key (lot_id) references lots(id)`
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `check (action_type in ('block_lot','quarantine_lot','scrap_lot','restock_lot','customer_notify'))`
- `check (status in ('planned','in_progress','completed','canceled'))`
- `index (recall_case_id, status)`

### `recall_communications`

Tracks communications sent (or attempted) as part of a recall case.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `recall_case_id` | `uuid` | no | FK → `recall_cases(id)` |
| `customer_id` | `uuid` | yes | FK → `customers(id)` |
| `channel` | `text` | no | enum-like: `email`, `phone`, `letter`, `portal` |
| `status` | `text` | no | enum-like: `draft`, `sent`, `failed` |
| `sent_at` | `timestamptz` | yes | |
| `subject` | `text` | yes | |
| `body` | `text` | yes | |
| `external_ref` | `text` | yes | e.g., email provider message id |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (recall_case_id) references recall_cases(id)`
- `foreign key (customer_id) references customers(id)`
- `check (channel in ('email','phone','letter','portal'))`
- `check (status in ('draft','sent','failed'))`
- `index (recall_case_id, created_at)`
- `index (customer_id, status)` (optional)

## Documented Computations

### A) Trace run computation (forward trace)

Given a recall case with targets:
1. Choose `as_of` (snapshot boundary).
2. Compute forward trace per Phase 7 Feature 2:
   - For each target lot (or lots derived from an item target), find impacted shipments and customers.
   - If `target_type='item'`, expand to lots using posted lot movements (and/or active lots) as-of `as_of` (no conversions).
3. Materialize impacted sets into `recall_impacted_shipments` (and optionally `recall_impacted_lots`) for the `recall_trace_run_id`.

### B) Action planning

Given impacted sets:
- For each impacted lot still on-hand, create containment actions (block/quarantine) as `recall_actions`.
- For shipments/customers, create notification actions and corresponding `recall_communications` drafts.

### C) Inventory disposition integration (docs-only linkage)

When an action requires inventory movement (e.g., scrap/restock/quarantine transfer):
- Link `recall_actions.inventory_movement_id` to the posted movement that implements it.
- Movements should follow Phase 4 Feature 5 disposition mapping rules.

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- Recall cases are auditable and append-only; do not delete cases, trace runs, or actions. Corrections are new records and audit logs.
- A `recall_trace_run` is immutable once computed; subsequent recomputation creates a new trace run and marks the prior as `superseded`.
- If an action links to a movement, that movement must be posted and must correspond to the intended action semantics.
  - For `scrap_lot`/`restock_lot`/`quarantine_lot`, the linked movement should be consistent with Phase 4 disposition mapping, and its `occurred_at` should be within the recall window (or explicitly documented otherwise).

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines schemas for recall case documents (`recall_cases`, `recall_case_targets`) with auditable status lifecycle.
2. Documentation defines trace run schemas (`recall_trace_runs`, `recall_impacted_shipments`, optional `recall_impacted_lots`) that snapshot impacted sets as-of a time boundary.
3. Documentation defines schemas for recall actions and communications (`recall_actions`, `recall_communications`) with linkage to lots, shipments/customers, and optional inventory movements.
4. Documentation defines documented computations for generating impacted sets from traceability outputs and planning actions/communications.
5. No production code is added (no migrations executed, no workflow engine, no automated sending).
