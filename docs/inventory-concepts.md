# Inventory Concepts (Phase 1)

This doc is the operational glossary for the inventory snapshot endpoint (`GET /inventory-snapshot`). All quantities are numeric, default to `0`, and never `null`.

## Field definitions

- `onHand`: Posted inventory movement quantity for the `itemId` at `locationId` and `uom` (ledger-derived, `inventory_movements.status = 'posted'`, using canonical quantity when present).
- `reserved`: Open commitment quantity shown by snapshot as total commitments (`RESERVED + ALLOCATED` open qty at the same `itemId`/`locationId`/`uom`).
- `available`: Canonical availability: `onHand - reservedQty - allocatedQty` (no additional clamping). In snapshot payload, this is exposed directly as `available`.
- `onOrder`: Outstanding purchase order quantity (`submitted` POs only) for the `itemId` and `uom` shipping to `locationId`, computed as `quantity_ordered - quantity_received`, clamped at `0`.
- `inTransit`: Received-but-not-posted/putaway quantity for the `itemId` and `uom` tied to `locationId` via `received_to_location_id` (fallback to PO `ship_to_location_id`), using accepted receipt qty minus posted putaway qty. Pending putaways remain in `inTransit`.
- `backordered`: Always `0` in Phase 1 (no first-class backorder source available yet).
- `inventoryPosition`: `onHand + onOrder + inTransit - reserved - backordered`.

## Reservation commitment mapping

- Reservation rows are location-scoped (`inventory_reservations.location_id` is required).
- Commitments are computed as `openQty = quantity_reserved - COALESCE(quantity_fulfilled, 0)`, clamped at `0`.
- State mapping for canonical commitment views:
  - `RESERVED` contributes only to `reserved_qty`
  - `ALLOCATED` contributes only to `allocated_qty`
  - `CANCELLED`, `EXPIRED`, and `FULFILLED` contribute to neither bucket
- Warehouse-level commitment views are rollups of location-grain commitments (no warehouse-only reservation rows).

## Reservation Consumption Allowance Policy

- Definition: shipment posting may pass stock validation when `available + reserveConsume >= shipQty`.
- `available` is canonical from `inventory_available_location_v`; `reserveConsume` is the portion of the linked reservation consumed by that shipment line in the same transaction.
- Why: shipping consumes that commitment immediately, so strict `available >= shipQty` would falsely block valid reservation-backed shipments.
- Hard constraint: this allowance is valid only in shipment posting for that reservation consumption path.
- No other service may add allowances or recompute availability outside canonical `inventory_available_*` views.

## Phantom BOM Expansion Guardrails

- Phantom source of truth: `items.is_phantom` on the component item (item policy), not a BOM-line flag.
- Phantom components are expanded recursively during work-order requirements explosion.
- Recursion trigger: only components whose item has `is_phantom = true` are expanded to their effective BOM children.
- Non-phantom components remain leaf requirements even if they have their own BOM.
- Traversal is deterministic (components sorted by `componentItemId`, then line `id`) so error paths are reproducible.
- Cycle detection is path-based: if expansion revisits an item already in the current recursion stack, it fails with `BOM_CYCLE_DETECTED` and `details.path` (for example `[A, B, C, A]`).
- A max depth guard (`BOM_EXPANSION_MAX_DEPTH`, default `20`) fails closed with `BOM_MAX_DEPTH_EXCEEDED` and the current path.
- These guardrails prevent infinite recursion only; they do not change ledger, FIFO, transfer costing, or availability semantics.

## Relationships

- `available = onHand - reservedQty - allocatedQty`
- `inventoryPosition = onHand + onOrder + inTransit - reserved - backordered`

## Warehouse Topology

- Canonical warehouse/location provisioning is defined in `seeds/topology/*.tsv`.
- `locations.code` is canonical (`UNIQUE (tenant_id, code)`); `locations.local_code` is warehouse-scoped bin label.
- Seed runner (check-only): `npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID>`.
- Seed runner repair mode: `npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID> --fix`.
- Topology/default drift check: `warehouse_topology_defaults_invalid` section in `scripts/inventory_invariants_check.mjs`.
- Full reference: `docs/warehouse-topology.md`.

## Approximations & limitations

- `onOrder` only considers POs in `submitted` status; drafts are ignored.
- `inTransit` uses receipt lines where `received_to_location_id` (or PO `ship_to_location_id` if missing) matches the requested `locationId`, and counts accepted quantity minus posted putaway movements. If QC is on hold with no accepted qty, `inTransit` will be `0` for that line.
- `backordered` is reported as `0` until a reliable signal exists.

## Glossary (API field → meaning)

- `itemId`: Item UUID (`items.id`), the canonical item key (not SKU).
- `locationId`: Location UUID (`locations.id`) — warehouse/bin/store/etc.
- `uom`: Unit of measure code used for the row.
- `onHand`: Posted quantity in ledger for that item/location/uom.
- `reserved`: Snapshot-facing committed quantity (`RESERVED + ALLOCATED` open qty).
- `available`: On-hand less open commitments; what remains to promise/consume.
- `onOrder`: Open PO quantity expected into that location/uom.
- `inTransit`: Received/accepted quantity not yet posted to inventory for that location/uom.
- `backordered`: Unfulfilled demand without stock; `0` here.
- `inventoryPosition`: Coverage metric (`onHand + onOrder + inTransit - reserved - backordered`).

## Planning and replenishment (Phase 2)

- Position-based checks: `inventoryPosition` is the decision quantity for reorder/Order-Up-To logic.
- Q/ROP: reorder when `inventoryPosition < reorderPointQty`; recommended quantity uses fixed `orderQuantityQty` (or the gap) with min/max applied.
- T/OUL: recommended quantity = `max(0, orderUpToLevelQty - inventoryPosition)` with min/max applied.
- Assumptions: Responses include an `assumptions[]` list when data is missing or heuristics are applied.
- Measured metric: “Fulfillment Fill Rate (measured)” = shipped quantity / ordered quantity from sales order shipment lines over a window; reported as `null` if no data exists.

## Verification checklist

1) Happy path curl:

```bash
curl -s "http://localhost:3000/inventory-snapshot?itemId=<ITEM_UUID>&locationId=<LOCATION_UUID>"
```

Expect `200` and `data` array sorted by `uom`; fields present with numeric values.

2) Invariants to spot-check on a sample row:

- `available === onHand - reservedQty - allocatedQty` (internally), and snapshot `reserved` already includes both commitment buckets
- `inventoryPosition === onHand + onOrder + inTransit - reserved - backordered`
- Missing sources imply `0` (never `null`)
- Query param UUIDs invalid → `400`; unknown `itemId`/`locationId` → `404`
