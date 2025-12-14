# Phase 3 — Feature 1: BOM / Recipes (Schemas + Acceptance Criteria Only)

This document defines the **schemas** and **posting-time validations (documented)** for Bills of Materials (BOMs) / recipes.
It is **documentation only** (no migrations, no ORM models, no runtime implementation).

## Scope

Supports:
- Defining a BOM/recipe for an assembled item (finished good) made from component items.
- Versioning and effective dating of BOMs.
- Capturing required component quantities per unit of output (yield-based).

Out of scope (Phase 3 Feature 1):
- Work orders / manufacturing execution.
- Backflushing, scrap reporting, labor/overhead costing.
- Lot/serial tracking.

## Conceptual Model

### BOM as a Specification

- A BOM/recipe is a **specification**: for a given output item, it lists component requirements.
- The BOM itself does not move inventory; later features (work orders) will consume components and produce outputs via inventory movements.

### UOM Assumption (Phase 3)

- No unit conversions are performed.
- Quantities are computed per `(item_id, uom)`; mixed-UOM is never summed.

## Proposed Relational Schema (PostgreSQL)

All timestamps are UTC.

### `boms`

Defines a BOM family for a single output item. Actual component definitions live in versions.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `bom_code` | `text` | no | Unique business identifier (human-facing) |
| `output_item_id` | `uuid` | no | FK → `items(id)` |
| `default_uom` | `text` | no | UOM of the output (e.g., `each`) |
| `active` | `boolean` | no | default true |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `unique (bom_code)`
- `foreign key (output_item_id) references items(id)`
- `index (output_item_id)`
- `index (active)`

### `bom_versions`

Versioned, effective-dated specifications for a BOM.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `bom_id` | `uuid` | no | FK → `boms(id)` |
| `version_number` | `integer` | no | Unique per BOM; monotonic recommended |
| `status` | `text` | no | enum-like: `draft`, `active`, `retired` |
| `effective_from` | `timestamptz` | yes | When this version becomes usable |
| `effective_to` | `timestamptz` | yes | When this version stops being usable |
| `yield_quantity` | `numeric(18,6)` | no | Output quantity produced by this recipe definition; must be > 0 |
| `yield_uom` | `text` | no | Must equal `boms.default_uom` (posting-time validation) |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |
| `updated_at` | `timestamptz` | no | |

Constraints / indexes:
- `foreign key (bom_id) references boms(id)`
- `unique (bom_id, version_number)`
- `check (status in ('draft','active','retired'))`
- `check (yield_quantity > 0)`
- `index (bom_id, status)`
- `index (effective_from, effective_to)` (optional)

### `bom_version_lines`

Component requirements for a specific BOM version.

| Column | Type | Null | Notes |
|---|---:|:---:|---|
| `id` | `uuid` | no | PK |
| `bom_version_id` | `uuid` | no | FK → `bom_versions(id)` |
| `line_number` | `integer` | no | 1-based; unique per version |
| `component_item_id` | `uuid` | no | FK → `items(id)` |
| `component_quantity` | `numeric(18,6)` | no | Quantity consumed per `yield_quantity`; must be > 0 |
| `component_uom` | `text` | no | No conversions in Phase 3 |
| `scrap_factor` | `numeric(18,6)` | yes | Optional multiplier (e.g., 0.02 for 2%); policy-defined |
| `notes` | `text` | yes | |
| `created_at` | `timestamptz` | no | default now() |

Constraints / indexes:
- `foreign key (bom_version_id) references bom_versions(id)`
- `foreign key (component_item_id) references items(id)`
- `unique (bom_version_id, line_number)`
- `check (component_quantity > 0)`
- `index (bom_version_id)`
- `index (component_item_id)`

## Documented Computations

### Per-unit component requirement

Given a BOM version line:
- `component_per_output_unit = component_quantity / yield_quantity`

For a desired output quantity `Q` (in `yield_uom`):
- `required_component_qty = component_per_output_unit * Q`

If `scrap_factor` is used (optional policy):
- `required_component_qty = required_component_qty * (1 + scrap_factor)`

Component quantity precision: component quantities are interpreted as exact numeric inputs; rounding policy (if any) is applied at execution time, not in BOM definition.

## Posting-Time Validations (Documented)

### Version activation and effective dating

Posting-time validation (application/service layer):
- Only one `bom_versions` row may be `active` per `bom_id` at a time (not enforceable via basic constraints).
- If effective dating is used, active selection must resolve to at most one version for an as-of timestamp.
- If multiple versions overlap for the same as-of time due to misconfiguration, posting-time validation must reject activation.

### UOM consistency

Posting-time validation:
- `bom_versions.yield_uom` must equal `boms.default_uom`.
- No unit conversions: the system must not sum or compare quantities across different UOMs without an explicit conversion feature (out of scope).

### Component sanity

Posting-time validation:
- A BOM must not include its own `output_item_id` as a direct component (no direct self-reference).
- Cycle prevention across multi-level BOMs (A uses B, B uses A) is a later-phase validation policy; Phase 3 docs only require stating the intent (no cycles).

## Acceptance Criteria (Schemas Only)

1. Documentation defines schemas for `boms`, `bom_versions`, and `bom_version_lines` including keys, fields, and constraints.
2. Documentation defines yield-based component computations (component per output unit) and optional scrap factor handling.
3. Documentation defines posting-time validations for version activation, effective dating, UOM consistency, and basic component sanity rules.
4. No production code is added (no migrations executed, no ORM/runtime model implementation).
