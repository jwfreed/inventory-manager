# Phase 1 — Feature 4: Inbound Completion / Receiving Closeout (Schemas + Acceptance Criteria Only)

This document defines the **schemas** for inbound closeout: formally completing an inbound receiving “unit of work” once receiving, QC disposition, and putaway are sufficiently finished.
It is **documentation only** (no migrations, no triggers, no ORM models, no runtime implementation).

## Scope

Supports:
- Grouping inbound work (typically one PO delivery) into a single closeout record.
- Deterministic “can close” checks (documented as posting-time validations).
- Recording who closed inbound and when, with optional notes/reason codes.

Out of scope (Phase 1 Feature 4):
- Work assignment / task queues.
- Automated reconciliation jobs.
- Advanced exception workflows (claims/returns authorizations).

## Conceptual Model

### Closeout as a Document Gate

- Closeout does not change inventory directly.
- Inventory authority remains the movement ledger (Phase 0 Feature 1).
- Closeout is a *business checkpoint* that says: “this inbound delivery is complete enough to stop further receiving/QC/putaway activity unless explicitly reopened”.

### What “Inbound” Groups

Phase 1 assumes inbound work is anchored on a `purchase_order_receipt` (Phase 1 Feature 1).
Closeout aggregates related documents:
- Receipt + receipt lines
- QC events / links (Phase 1 Feature 2)
- Putaways / putaway lines (Phase 1 Feature 3)

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `inbound_closeouts`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `purchase_order_receipt_id` | `uuid` | no | FK → `purchase_order_receipts(id)`; anchor |
| `status` | `text` | no | enum-like: `open`, `closed`, `reopened` |
| `closed_at` | `timestamptz` | yes | Set when status becomes `closed` |
| `closed_by_actor_type` | `text` | yes | enum-like: `user`, `system` |
| `closed_by_actor_id` | `text` | yes | |
| `closeout_reason_code` | `text` | yes | e.g., `complete`, `short_ship`, `damaged`, `exception_approved` |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (purchase_order_receipt_id) references purchase_order_receipts(id)`
- `unique (purchase_order_receipt_id)` (one closeout record per receipt)
- `check (status in ('open','closed','reopened'))`
- `check (closed_by_actor_type in ('user','system'))`
- `index (status, created_at)`

### `inbound_closeout_snapshots` (Optional, Docs Only)

Optional immutable snapshot of “completion state” at close time to support later auditing/reconciliation without recomputing from mutable documents.
Snapshot contents are intentionally a **small summary only** (counts, totals, flags) and must not embed large per-line payloads or duplicate detailed document state.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `inbound_closeout_id` | `uuid` | no | FK → `inbound_closeouts(id)` |
| `snapshot_at` | `timestamptz` | no | default now() |
| `data` | `jsonb` | no | Small summary (counts, totals, flags) |

Constraints / indexes:
- `foreign key (inbound_closeout_id) references inbound_closeouts(id)`
- `unique (inbound_closeout_id)` (single snapshot per closeout, if used)
- `index (snapshot_at)`

## Posting-Time Validations (Documented)

### Preconditions to close

Posting-time validation (application/service layer):
Closeout check scope (Phase 1): Closeout preconditions are evaluated only over records linked by FK to the anchor `purchase_order_receipt_id` (e.g., receipt lines, QC events linked to those receipt lines, putaways whose `purchase_order_receipt_id` references the receipt), not by global location/time inference.
- Closeout can occur only if the anchor `purchase_order_receipt` is considered posted/effective per Phase 1 Feature 1:
  - It must be linked to a `posted` receive-type `inventory_movement` (or meet whatever “receipt posted” policy is chosen).
- For the receipt’s lines:
  - No line may remain `qc_status='pending'` or `qc_status='held'` (Phase 1 Feature 2), unless closeout is explicitly allowed under an exception policy.
  - If QC remains `pending`/`held` at closeout under an exception policy, `closeout_reason_code` must be set to an exception code and `notes` are recommended.
- Putaway completion policy (Phase 1 baseline):
  - If putaways exist for this receipt context, no associated `putaway` may remain `draft`/`in_progress`, and no `putaway_line` may remain `pending`.
  - If no putaway exists, closeout is still allowed (e.g., directing putaway to later work) unless a stricter policy is desired.

### Effects of closing

Posting-time validation (application/service layer):
- When `status` becomes `closed`, the system should prevent creation of additional receiving/QC/putaway activity for the anchored receipt unless `status` is later set to `reopened`.
- `closed_at` and `closed_by_*` must be set when closing.

### Reopen semantics

Posting-time validation:
- `reopened` indicates further activity is permitted again for the anchored receipt.
- Reopening does not roll back inventory; it only re-allows documents/work.
- `reopened` is an audit-distinct state meaning “previously closed”; implementations may require a reason/notes when transitioning from `closed` → `reopened`.

## Acceptance Criteria (Schemas Only)

1. Documentation defines an `inbound_closeouts` schema anchored to `purchase_order_receipts` with statuses and close metadata (who/when/why).
2. Documentation defines optional `inbound_closeout_snapshots` to capture a close-time summary without implementing population logic.
3. Documentation defines posting-time validations for “can close” checks spanning receipt posting, QC status, and putaway completion.
4. Documentation defines closeout effects and reopen semantics at the document/policy level (no inventory side effects).
5. No production code is added (no migrations executed, no ORM/runtime model implementation).
