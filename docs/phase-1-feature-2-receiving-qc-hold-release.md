# Phase 1 — Feature 2: Receiving + QC Hold/Release (Schemas + Acceptance Criteria Only)

This document defines the **schemas** for receiving workflow and quality-control (QC) hold/release.
It is **documentation only** (no migrations, no triggers, no ORM models, no runtime implementation).

## Scope

Supports:
- Capturing a receiving event (already introduced as `purchase_order_receipts` in Phase 1 Feature 1).
- Recording QC disposition per receipt line (hold / accept / reject).
- Releasing held quantity into available stock via inventory movements.

Out of scope (Phase 1 Feature 2):
- Detailed test plans, sampling rules, spec/COA tracking.
- Serial/lot tracking.
- Automated quarantine location assignment.

## Conceptual Model

### Documents vs Inventory Ledger

- Receipts and QC records are **documents** (who inspected what, and what disposition was assigned).
- Inventory on-hand is still derived solely from the **inventory movement ledger** (Phase 0 Feature 1).

### QC Hold Strategy (Documented)

Phase 1 assumes a **two-step inventory strategy**:
1. Receiving creates a `receive`-type `inventory_movement` into a designated **QC hold location**.
2. QC release (accept) creates a `transfer` movement from QC hold → available location.
3. QC reject creates a movement policy-defined as either:
   - `transfer` from QC hold → scrap/return location, or
   - `issue` from QC hold (if modeling disposal), depending on future policy.

This document defines linkages only; exact policy is implementation-time.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `purchase_order_receipt_lines` (Extension)

Adds QC status fields to the existing table from Phase 1 Feature 1.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `qc_status` | `text` | no | enum-like: `pending`, `held`, `accepted`, `rejected` |
| `qc_updated_at` | `timestamptz` | yes | When `qc_status` last changed |

Constraints / indexes:
- `check (qc_status in ('pending','held','accepted','rejected'))`
- `index (qc_status)`

### `qc_events`

Append-only QC events for receipt lines (hold/release/reject). This provides an audit-like trail specific to QC decisions.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `purchase_order_receipt_line_id` | `uuid` | no | FK → `purchase_order_receipt_lines(id)` |
| `event_type` | `text` | no | enum-like: `hold`, `accept`, `reject` |
| `quantity` | `numeric(18,6)` | no | Must be > 0; quantity affected by this event |
| `uom` | `text` | no | Must match receipt line UOM |
| `reason_code` | `text` | yes | e.g., `damage`, `expired`, `failed_inspection` |
| `notes` | `text` | yes | |
| `actor_type` | `text` | no | enum-like: `user`, `system` |
| `actor_id` | `text` | yes | |
| `occurred_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (purchase_order_receipt_line_id) references purchase_order_receipt_lines(id)`
- `check (event_type in ('hold','accept','reject'))`
- `check (quantity > 0)`
- `check (actor_type in ('user','system'))`
- `index (purchase_order_receipt_line_id, occurred_at)`
- `index (event_type, occurred_at)`

### `qc_inventory_links`

Links QC events to the inventory movement that operationalizes them (release/transfer/issue).

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `qc_event_id` | `uuid` | no | FK → `qc_events(id)` |
| `inventory_movement_id` | `uuid` | no | FK → `inventory_movements(id)` |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (qc_event_id) references qc_events(id)`
- `foreign key (inventory_movement_id) references inventory_movements(id)`
- `unique (qc_event_id)`
- `index (inventory_movement_id)`

## Posting-Time Validations (Documented)

### Receipt line QC status derivation

Posting-time validation (application/service layer):
- `purchase_order_receipt_lines.qc_status` is derived from QC events and/or explicit QC actions:
  - Default: `pending` on receipt creation.
  - If any quantity is put on hold: `held`.
  - If the full received quantity is dispositioned as accept/reject: terminal status `accepted` or `rejected`.
- Mixed dispositions are allowed at the event level; the line-level `qc_status` is a summary indicator.
  - Summary precedence (deterministic, Phase 1):
    - If any quantity remains `pending` or `held`, set `qc_status='held'`.
    - Else if accepted quantity > 0 and rejected quantity = 0, set `qc_status='accepted'`.
    - Else if rejected quantity > 0 and accepted quantity = 0, set `qc_status='rejected'`.
    - Else (accepted > 0 and rejected > 0 with none held): keep `qc_status='accepted'` as a summary and treat “mixed” as a display/reporting concept only (no new enum required).

### Quantity accounting

Posting-time validation:
- For each receipt line, the sum of QC event quantities (by event type) must not exceed the receipt line’s `quantity_received`.
- `qc_events.uom` must match the receipt line UOM (cross-table equality; not enforceable by basic constraints).

### Inventory movements required for effective disposition

Posting-time validation:
- A QC `accept` event is considered **effective** only when linked (via `qc_inventory_links`) to a `posted` inventory movement that releases stock from QC hold to the destination location (usually a `transfer`).
- A QC `reject` event is considered **effective** only when linked to a `posted` movement that moves stock out of QC hold per policy (scrap/return/issue).
- The receipt’s initial `receive` movement should place quantities into the designated QC hold location when QC is enabled for that receipt/location.
  - Phase 1 assumption: “QC enabled” is an implementation-time policy flag (hardcoded or configured later); the schema does not encode it yet.

### Append-only QC events and reversals

QC events are append-only:
- Do not edit or delete `qc_events` rows to correct mistakes.
- Corrections/reversals are represented by new QC event(s) (and corresponding inventory movements), preserving a complete trail.

## Acceptance Criteria (Schemas Only)

1. Documentation defines how receiving and QC decisions relate to the inventory ledger (movements are the source of truth for on-hand).
2. Documentation specifies schema extensions for `purchase_order_receipt_lines` to track `qc_status` (and timestamp).
3. Documentation defines a `qc_events` table capturing hold/accept/reject actions with quantities, UOM, reasons, actors, and timestamps.
4. Documentation defines a linkage table `qc_inventory_links` connecting QC events to the inventory movements that implement the physical disposition.
5. Documentation defines posting-time validations for QC quantity limits, UOM matching, and movement linkage requirements.
6. No production code is added (no migrations executed, no ORM/runtime model implementation).
