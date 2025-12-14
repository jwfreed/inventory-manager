# Phase 0 — Feature 2: Location Hierarchy + Audit Logging (Docs Only)

This document defines the **schemas** and **acceptance criteria** for:
- Location hierarchy (parent/child locations)
- Audit logging (who did what, when, to which record)

It is **documentation only** (no migrations, triggers, ORM models, or runtime implementation).

## Scope

### In scope
- Representing a tree of locations (warehouse → aisle → bin).
- Validating hierarchy integrity at the schema/constraint level where feasible.
- Capturing an append-only audit log of domain changes (create/update/delete and posting actions).

### Out of scope (Phase 0)
- Permission models / RBAC.
- Automated audit population (middleware/triggers).
- Multi-tenant partitioning.
- Data retention policies and log archival.

## Location Hierarchy

### Overview

`locations` are hierarchical via a self-referencing parent key:
- `parent_location_id` is `NULL` for a root location.
- Children reference a parent location in the same table.

This supports:
- Querying “all bins in warehouse X”
- Displaying a tree in UI
- Enforcing that certain location types can/can’t be parents (optional constraints)

### Schema: `locations` (Extension)

This extends the Phase 0 Feature 1 `locations` table with hierarchy fields.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `parent_location_id` | `uuid` | yes | FK → `locations(id)`; `NULL` means root |
| `path` | `text` | yes | Optional materialized path for fast subtree reads (e.g., `/WH1/AISLE3/BIN7`) |
| `depth` | `integer` | yes | Optional cached depth for UI/sorting (0=root) |

Constraints / indexes:
- `foreign key (parent_location_id) references locations(id)`
- `check (parent_location_id <> id)` (no self-parenting)
- `index (parent_location_id)`
- If `path` is used: `unique (path)` and `index (path)` (optional)

### Hierarchy Integrity Rules (Documented)

Some hierarchy constraints are difficult to guarantee with basic relational constraints alone; document the intended rules:

1. **No cycles (Phase 0 enforcement)**: enforced by application/service validation when creating/updating `parent_location_id` (Option A baseline); not enforceable with basic FK/check constraints alone.
2. **Single parent**: each location has at most one parent (enforced by schema).
3. **Consistent activity** (policy): optional rule that inactive parents should not have active children (enforced later in service layer).
4. **Type parenting rules** (optional policy):
   - Example: `warehouse` can contain `aisle`; `aisle` can contain `bin`; `bin` cannot have children.

### Recommended Approach for Cycle Prevention (Choose One Later)

Phase 0 documents the options; implementation is deferred:

- **Option A: Adjacency list only** (`parent_location_id`)
  - Simple schema; cycle prevention requires app/service validation.
- **Option B: Materialized path** (`path`, `depth`)
  - Fast subtree queries; cycles prevented by validation when computing path.
- **Option C: Closure table** (add `location_closure` table)
  - Strong integrity and fast ancestor/descendant queries; more complex.

For Phase 0 schema docs, adopt **Option A** as the baseline, with **optional** `path/depth` fields if needed later.

## Audit Logging

### Overview

Audit logs are append-only records describing changes to domain objects.
They are intended for:
- Traceability (who changed what)
- Debugging (when did a discrepancy get introduced)
- Compliance (basic change history)

### Schema: `audit_log`

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `occurred_at` | `timestamptz` | no | default now() |
| `actor_type` | `text` | no | enum-like: `user`, `system` |
| `actor_id` | `text` | yes | User id or system identifier (string to decouple auth system) |
| `action` | `text` | no | enum-like: `create`, `update`, `delete`, `post`, `unpost` (if ever allowed) |
| `entity_type` | `text` | no | e.g., `item`, `location`, `inventory_movement` |
| `entity_id` | `uuid` | no | Target entity id |
| `request_id` | `text` | yes | Correlate multiple events in one request |
| `metadata` | `jsonb` | yes | Freeform small context (ip, user_agent, etc.) |
| `before` | `jsonb` | yes | Snapshot before change (only for update/delete) |
| `after` | `jsonb` | yes | Snapshot after change (only for create/update) |

Constraints / indexes:
- `check (actor_type in ('user','system'))`
- `check (action in ('create','update','delete','post','unpost'))` (note: `unpost` is documented but not recommended)
- `index (occurred_at)`
- `index (entity_type, entity_id, occurred_at)`
- `index (actor_type, actor_id, occurred_at)`
- `index (request_id)` (optional)

### Audit Event Guidance (Documented)

- `entity_type` vocabulary: treat `entity_type` as an enum-like controlled set (e.g., `item`, `location`, `inventory_movement`, `inventory_movement_line`). Do not allow arbitrary free-text values in application code; enforce consistency via constants (and optionally a DB enum later).
- Snapshot policy: `before` / `after` are whitelisted-field snapshots, not necessarily full-row dumps. Store only fields required for traceability/debugging (avoid large blobs). For sensitive fields, prefer redaction or omission.
- For `inventory_movements` posting:
  - Emit one `audit_log` entry with `action='post'` on `entity_type='inventory_movement'`.
  - Optionally include line summaries in `metadata` (counts, totals) rather than full duplication.
- Audit logs are **append-only**; do not update or delete audit records (except via retention/archival in later phases).

## Acceptance Criteria (Schemas Only)

1. Documentation defines how `locations` form a hierarchy (parent/child) and lists required integrity rules (no self-parenting, no cycles).
2. Documentation specifies schema additions for location hierarchy:
   - `parent_location_id` (FK to `locations`)
   - optional `path` and `depth` fields, with stated purpose
3. Documentation defines an `audit_log` table schema with:
   - actor identification (`actor_type`, `actor_id`)
   - action (`create/update/delete/post`)
   - entity target (`entity_type`, `entity_id`)
   - timestamps and optional correlation (`request_id`)
   - optional `before`/`after` JSON snapshots
4. Documentation states audit logs are append-only and describes posting-related audit expectations.
5. No production code is added (no migrations executed, no triggers/middleware, no runtime implementation).
