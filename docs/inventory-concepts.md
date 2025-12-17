# Inventory Concepts (Phase 1)

This doc is the operational glossary for the inventory snapshot endpoint (`GET /inventory-snapshot`). All quantities are numeric, default to `0`, and never `null`.

## Field definitions

- `onHand`: Posted inventory movement quantity for the `itemId` at `locationId` and `uom` (ledger-derived, `inventory_movements.status = 'posted'`).
- `reserved`: Sales-order reservation quantity still outstanding at the same `itemId`/`locationId`/`uom` (statuses `open` + `released`, computed as `quantity_reserved - quantity_fulfilled`, clamped at `0`).
- `available`: `onHand - reserved` (no additional clamping).
- `onOrder`: Outstanding purchase order quantity (`submitted` POs only) for the `itemId` and `uom` shipping to `locationId`, computed as `quantity_ordered - quantity_received`, clamped at `0`.
- `inTransit`: Received-but-not-posted/putaway quantity for the `itemId` and `uom` tied to `locationId` via `received_to_location_id` (fallback to PO `ship_to_location_id`), using accepted receipt qty minus posted putaway qty. Pending putaways remain in `inTransit`.
- `backordered`: Always `0` in Phase 1 (no first-class backorder source available yet).
- `inventoryPosition`: `onHand + onOrder + inTransit - reserved - backordered`.

## Relationships

- `available = onHand - reserved`
- `inventoryPosition = onHand + onOrder + inTransit - reserved - backordered`

## Approximations & limitations

- `onOrder` only considers POs in `submitted` status; drafts are ignored.
- `inTransit` uses receipt lines where `received_to_location_id` (or PO `ship_to_location_id` if missing) matches the requested `locationId`, and counts accepted quantity minus posted putaway movements. If QC is on hold with no accepted qty, `inTransit` will be `0` for that line.
- `backordered` is reported as `0` until a reliable signal exists.

## Glossary (API field → meaning)

- `itemId`: Item UUID (`items.id`), the canonical item key (not SKU).
- `locationId`: Location UUID (`locations.id`) — warehouse/bin/store/etc.
- `uom`: Unit of measure code used for the row.
- `onHand`: Posted quantity in ledger for that item/location/uom.
- `reserved`: Open/released sales-order allocations at that location/uom.
- `available`: On-hand less reserved; what remains to allocate.
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

- `available === onHand - reserved`
- `inventoryPosition === onHand + onOrder + inTransit - reserved - backordered`
- Missing sources imply `0` (never `null`)
- Query param UUIDs invalid → `400`; unknown `itemId`/`locationId` → `404`
