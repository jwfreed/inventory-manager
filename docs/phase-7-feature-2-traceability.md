# Phase 7 — Feature 2: Forward/Backward Traceability (Lot → Finished Goods → Customers; Finished Lot → Consumed Lots) — Schemas + Computations + Acceptance Criteria Only

This document defines **schemas** and **documented computations** for lot-based traceability reports:
- Forward trace: raw/component lot → finished goods lots → shipments/customers
- Backward trace: finished lot → consumed component lots

It is **documentation only** (no migrations, no runtime traceability engine, no production code).

## Scope

Supports:
- Representing lots/batches for items.
- Recording lot-level inventory movements (lot quantities per movement line).
- Linking manufacturing execution (work order executions) to the ledger so trace reports can traverse components → outputs.
- Linking shipments to the ledger so trace reports can traverse finished lots → customers.

Out of scope (Phase 7 Feature 2):
- Serial-number traceability.
- Regulatory compliance workflows (recall execution tooling).
- Lot attribute validation rules (expiry enforcement, quarantines), beyond schema-level capture.

## Authority and Data Sources

- Inventory movements are authoritative for physical stock transitions (Phase 0 Feature 1).
- Work order executions and their linked movements are authoritative for “what was consumed/produced” (Phase 3 Feature 2).
- Sales shipments are authoritative for “what was shipped to a customer”, and are linked to issue movements (Phase 4 Feature 1).

Traceability is a reporting graph over these linkages; it does not change inventory.

## Canonical Dimensions

All traceability quantities are computed per:
- `item_id`
- `lot_id`
- `uom`
- `location_id` (where applicable)

No unit conversions are performed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `lots`

Represents a batch/lot for an item.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `item_id` | `uuid` | no | FK → `items(id)` |
| `lot_code` | `text` | no | Business identifier printed on packaging |
| `status` | `text` | no | enum-like: `active`, `quarantine`, `blocked`, `consumed`, `expired` |
| `manufactured_at` | `timestamptz` | yes | |
| `received_at` | `timestamptz` | yes | |
| `expires_at` | `timestamptz` | yes | |
| `vendor_lot_code` | `text` | yes | Supplier-provided lot (if applicable) |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (item_id) references items(id)`
- `unique (item_id, lot_code)`
- `check (status in ('active','quarantine','blocked','consumed','expired'))`
- `index (item_id, status)`
- `index (expires_at)` (optional)

### `inventory_movement_lots`

Lot-level quantities for each inventory movement line. This is the core join table enabling traceability.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `inventory_movement_line_id` | `uuid` | no | FK → `inventory_movement_lines(id)` |
| `lot_id` | `uuid` | no | FK → `lots(id)` |
| `uom` | `text` | no | Must match movement line `uom` |
| `quantity_delta` | `numeric(18,6)` | no | Non-zero; sign matches movement line semantics |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (inventory_movement_line_id) references inventory_movement_lines(id)`
- `foreign key (lot_id) references lots(id)`
- `check (quantity_delta <> 0)`
- `index (lot_id)`
- `index (inventory_movement_line_id)`

### `work_order_lot_links` (Optional, Docs Only)

Optional explicit linkage between work order executions and the lot-level movement lines they produced/consumed.
This can be derived through `work_order_executions` → movement ids, but a direct join can simplify reporting.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `work_order_execution_id` | `uuid` | no | FK → `work_order_executions(id)` |
| `inventory_movement_lot_id` | `uuid` | no | FK → `inventory_movement_lots(id)` |
| `role` | `text` | no | enum-like: `consume`, `produce` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (work_order_execution_id) references work_order_executions(id)`
- `foreign key (inventory_movement_lot_id) references inventory_movement_lots(id)`
- `check (role in ('consume','produce'))`
- `index (work_order_execution_id)`
- `index (inventory_movement_lot_id)`

### `shipment_lot_links` (Optional, Docs Only)

Optional explicit linkage between sales shipments and lot-level issue movement lines.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `sales_order_shipment_id` | `uuid` | no | FK → `sales_order_shipments(id)` |
| `inventory_movement_lot_id` | `uuid` | no | FK → `inventory_movement_lots(id)` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (sales_order_shipment_id) references sales_order_shipments(id)`
- `foreign key (inventory_movement_lot_id) references inventory_movement_lots(id)`
- `index (sales_order_shipment_id)`
- `index (inventory_movement_lot_id)`

## Posting-Time Validations (Documented)

Posting-time validation (application/service layer):
- Lot postings are atomic with movement posting: lot rows are considered effective only when their parent movement is posted.
- `inventory_movement_lots.uom` must equal the referenced `inventory_movement_lines.uom` (cross-table equality; posting-time validation).
- Default (Phase 7): require full allocation per movement line; partial allocation is disallowed unless a specific audited exception policy is enabled.
- For a given `inventory_movement_line_id`, the sum of `inventory_movement_lots.quantity_delta` must equal the movement line’s `quantity_delta` (full lot allocation), unless partial lot allocation is explicitly allowed and audited.
- Lots must match item identity: `lots.item_id` must equal the movement line’s `item_id` (posting-time validation; cross-table).
Lot status is informational; trace reports must rely on movement deltas (and posted state), not `lots.status`, for correctness.

## Documented Computations (Trace Graph)

### A) Backward trace: finished lot → consumed lots

Goal:
- Given a finished lot `L_finished`, find all component lots that were consumed to produce it (and recursively upstream).

Documented join path (Phase 7 baseline):
1. Find posted movement lot rows where `lot_id = L_finished` and `quantity_delta > 0` (production into inventory).
2. Identify the producing work order execution(s) via:
   - `work_order_executions.production_movement_id` matching the parent movement, or
   - `work_order_lot_links` if implemented.
3. From those executions, find consumed movement lot rows where `quantity_delta < 0` and join to their `lot_id` values.
4. Repeat recursively for each consumed lot if you want full upstream genealogy.

Termination:
- Stop at purchased/raw material lots or when no upstream producer exists.

### B) Forward trace: component lot → finished lots → shipments/customers

Goal:
- Given a component lot `L_component`, find all finished lots/products and customers impacted.

Documented join path (Phase 7 baseline):
1. Find posted movement lot rows where `lot_id = L_component` and `quantity_delta < 0` (consumption out of inventory).
2. Identify consuming work order execution(s) via:
   - `work_order_executions.consumption_movement_id`, or
   - `work_order_lot_links` if implemented.
3. For each execution, find produced movement lot rows where `quantity_delta > 0` to get finished lots.
4. For each finished lot, find posted issue movement lot rows where that `lot_id` has `quantity_delta < 0` and identify shipments via:
   - `sales_order_shipments.inventory_movement_id` matching that issue movement, or
   - `shipment_lot_links` if implemented.
5. Join shipment → `sales_orders.customer_id` to identify customers.

Notes:
- Returns (Phase 4 Feature 5) can be included as a separate report cut by linking return receipt movements to lots.
- Over-shipments and compensating movements remain visible in the ledger; reports should cap/label as needed for compliance views (policy).

### C) Lot on-hand (as-of) (supporting report)

Lot-level on-hand for `(lot_id, location_id, uom)` is derived from lot movement deltas:
- Sum `inventory_movement_lots.quantity_delta` for posted parent movements, grouped by lot and location (from the referenced movement line).
`location_id` for lot deltas is taken from `inventory_movement_lines.location_id` (not duplicated in `inventory_movement_lots`), so the join is required.

## Acceptance Criteria (Schemas + Computations Only)

1. Documentation defines `lots` and `inventory_movement_lots` schemas enabling lot-level quantities on movement lines.
2. Documentation defines posting-time validations for UOM/item consistency and full allocation of movement line quantity to lots (or explicitly documents partial allocation policy).
3. Documentation defines forward trace computation from component lots to finished lots to shipments/customers using documented join paths.
4. Documentation defines backward trace computation from finished lots to consumed component lots using documented join paths.
5. Documentation defines optional explicit link tables (`work_order_lot_links`, `shipment_lot_links`) as docs-only and explains they are convenience joins.
6. No production code is added (no migrations executed, no runtime implementation).
