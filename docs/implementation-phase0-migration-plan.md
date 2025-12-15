# Implementation Layer — Phase 0 Features 1–2

This document describes the **PostgreSQL migration plan** for Phase 0 Feature 1 (Domain model + inventory movement schema) and Phase 0 Feature 2 (Location hierarchy + audit logging).

## Scope

- Define tables in the order they must be created, including columns, indexes, and DB-enforceable constraints.
- Explicitly list validations that must remain in the service layer (cannot be enforced by PostgreSQL alone).
- No application code or data-loading logic.

## Ordered Migration Plan

### Migration 1 — `items`

```sql
CREATE TABLE items (
    id uuid PRIMARY KEY,
    sku text NOT NULL UNIQUE,
    name text NOT NULL,
    description text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_items_active ON items(active);
```

### Migration 2 — `locations`

```sql
CREATE TABLE locations (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    type text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_locations_type ON locations(type);
CREATE INDEX idx_locations_active ON locations(active);
ALTER TABLE locations
    ADD CONSTRAINT chk_locations_type
        CHECK (type IN ('warehouse','bin','store','customer','vendor','scrap','virtual'));
```

### Migration 3 — `inventory_movements`

```sql
CREATE TABLE inventory_movements (
    id uuid PRIMARY KEY,
    movement_type text NOT NULL,
    status text NOT NULL,
    external_ref text,
    occurred_at timestamptz NOT NULL,
    posted_at timestamptz,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL
);
CREATE INDEX idx_inventory_movements_status ON inventory_movements(status);
CREATE INDEX idx_inventory_movements_type_occurred
    ON inventory_movements(movement_type, occurred_at);
CREATE INDEX idx_inventory_movements_external_ref
    ON inventory_movements(external_ref);
ALTER TABLE inventory_movements
    ADD CONSTRAINT chk_inventory_movements_status
        CHECK (status IN ('draft','posted'));
ALTER TABLE inventory_movements
    ADD CONSTRAINT chk_inventory_movements_type
        CHECK (movement_type IN ('receive','issue','transfer','adjustment','count'));
```

### Migration 4 — `inventory_movement_lines`

```sql
CREATE TABLE inventory_movement_lines (
    id uuid PRIMARY KEY,
    movement_id uuid NOT NULL REFERENCES inventory_movements(id) ON DELETE CASCADE,
    item_id uuid NOT NULL REFERENCES items(id),
    location_id uuid NOT NULL REFERENCES locations(id),
    quantity_delta numeric(18,6) NOT NULL,
    uom text NOT NULL,
    reason_code text,
    line_notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_movement_lines_movement_id ON inventory_movement_lines(movement_id);
CREATE INDEX idx_movement_lines_item_location ON inventory_movement_lines(item_id, location_id);
CREATE INDEX idx_movement_lines_location_item ON inventory_movement_lines(location_id, item_id);
ALTER TABLE inventory_movement_lines
    ADD CONSTRAINT chk_movement_lines_qty_nonzero CHECK (quantity_delta <> 0);
```

### Migration 5 — `locations` hierarchy extension

```sql
ALTER TABLE locations
    ADD COLUMN parent_location_id uuid REFERENCES locations(id),
    ADD COLUMN path text,
    ADD COLUMN depth integer;

CREATE INDEX idx_locations_parent ON locations(parent_location_id);
ALTER TABLE locations
    ADD CONSTRAINT chk_locations_parent_not_self
        CHECK (parent_location_id IS NULL OR parent_location_id <> id);
-- If path is used later, unique/path indexes can be added then (documented optional).
```

### Migration 6 — `audit_log`

```sql
CREATE TABLE audit_log (
    id uuid PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_type text NOT NULL,
    actor_id text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    request_id text,
    metadata jsonb,
    before jsonb,
    after jsonb
);
CREATE INDEX idx_audit_log_occurred ON audit_log(occurred_at);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, occurred_at);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_type, actor_id, occurred_at);
CREATE INDEX idx_audit_log_request_id ON audit_log(request_id);
ALTER TABLE audit_log
    ADD CONSTRAINT chk_audit_log_actor_type CHECK (actor_type IN ('user','system'));
ALTER TABLE audit_log
    ADD CONSTRAINT chk_audit_log_action CHECK (action IN ('create','update','delete','post','unpost'));
```

## Validations Remaining in the Service Layer

The following rules **cannot** be enforced by PostgreSQL alone and must remain in application/service logic:

1. **Movement posting invariants**
   - `inventory_movements.status` transitions (draft→posted) must be atomic with posting business logic.
   - `occured_at` vs `posted_at` semantics (e.g., `posted_at` set when posting).

2. **Sign conventions**
   - `quantity_delta > 0` for receives and `< 0` for issues are posting-time validations; DB only ensures non-zero.

3. **Transfer balancing**
   - Transfers must net to zero per `(item_id, uom)`; no direct DB constraint across rows.

4. **Movement semantics for `movement_type='transfer'`**
   - Ensuring each transfer has matching source/destination lines is application logic.

5. **Hierarchy integrity beyond simple checks**
   - Preventing cycles in the `locations` hierarchy and enforcing type parenting rules are service-layer validations.

6. **Audit log content**
   - Ensuring `entity_type` uses an allowed vocabulary and that `before/after` snapshots follow the minimal JSON policy is application logic.

7. **Lot/traceability (Phase 0 does not introduce lots yet)**
   - Not applicable at Phase 0, but when lots are introduced later, cross-table consistency and full allocation validations require service-layer enforcement.

8. **On-hand derivation**
   - Aggregations and negative-on-hand policies are computed outside the database schema (e.g., service-layer reporting queries).

This plan establishes the base tables/constraints necessary for Phase 0 features while documenting where higher-level invariants must be enforced in code.
