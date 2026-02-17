# Transfer Costing Invariants

Transfer posting is now responsible for FIFO relocation in the same transaction as ledger posting.

## Invariants

- Ledger is authoritative and immutable after posting.
- Cost layers are immutable for identity/provenance and unit cost after insert.
- Every posted transfer line pair (out/in) must be cost-linked in `cost_layer_transfer_links`.
- Quantity conservation:
  - Sum of link quantities per transfer-out line equals `abs(quantity_delta)`.
  - Sum of link quantities per transfer-in line equals `quantity_delta`.
- Value conservation:
  - Source linked value equals destination linked value.
  - Link extended cost equals `quantity * unit_cost`.
- Transfer links are tenant-safe and dimension-safe (item/location/uom and line sign checks).

## FIFO Relocation Rules

- Transfer consumes source layers in FIFO order with `FOR UPDATE` locking.
- For each consumed segment, one destination `transfer_in` layer is created with identical unit cost.
- One auditable link row is written per consumed segment (`source layer -> destination layer`).

## Cost Layer Immutability

- Immutable after insert: `tenant_id`, `item_id`, `location_id`, `uom`, `layer_date`, `layer_sequence`,
  `original_quantity`, `unit_cost`, `source_type`, `source_document_id`, `movement_id`, `lot_id`, `created_at`.
- Mutable on active rows: `remaining_quantity`, `extended_cost`, `notes`, `updated_at`, `voided_at`, `void_reason`,
  `superseded_by_id`.
- Unvoid is forbidden (`voided_at` cannot be set back to `NULL`).
- Voided rows are frozen for quantity/value and provenance fields; only `void_reason` and `updated_at` may change.
- Corrections must be posted as new movements/layers (or supersession/void flows), never by updating `unit_cost`.

## Canonical Valuation (Policy B)

- Canonical inventory value is always `remaining_quantity * unit_cost` at query time.
- `inventory_cost_layers.extended_cost` is cache/informational only and is not authoritative.
- Valuation views and reports must aggregate `SUM(remaining_quantity * unit_cost)` to avoid drift and rounding ambiguity.

## Link Semantic Integrity

- A link row must align across tenant/item/location/uom:
  - out line <-> source layer
  - in line <-> destination layer
  - and out/in sides must match each other.
- Cross-dimension or cross-tenant mismatches are rejected with `TRANSFER_COST_LINK_DIMENSION_MISMATCH`.
- Deferred conservation checks validate both movement-level and per-item value conservation.

## Reversal Policy

- Transfer void posts a new `transfer_reversal` movement (no mutation of posted rows).
- Reversal target cannot itself be a reversal.
- Reversal is blocked if any destination layer created by the original transfer has been consumed.
- If allowed, reversal consumes those destination layers and recreates layers at the original source with the same unit cost, with full link audit.
