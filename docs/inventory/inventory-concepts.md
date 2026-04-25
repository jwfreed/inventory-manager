# Inventory Concepts (Phase 1)

This doc is the operational glossary for the inventory snapshot endpoint (`GET /inventory-snapshot`) and the replenishment planning path. Snapshot semantics and replenishment semantics intentionally diverge in this phase. All quantities are numeric, default to `0`, and never `null`.

## Field definitions

- `onHand`: Posted physical stock quantity for the `itemId` at `locationId` and `uom` (ledger-derived, `inventory_movements.status = 'posted'`, using canonical quantity when present).
- `usableOnHand`: Sellable on-hand stock used only by replenishment logic. This is derived from `inventory_available_location_sellable_v`, not exposed by the snapshot API, and may be lower than physical `onHand`.
- `reserved`: Open commitment quantity shown by snapshot as total commitments (`RESERVED + ALLOCATED` open qty at the same `itemId`/`locationId`/`uom`).
- `available`: ATP metric: `onHand - reservedQty - allocatedQty` (no additional clamping). In snapshot payload, this is exposed directly as `available`.
- `onOrder`: Replenishment inbound approximation based on approved / partially received PO outstanding quantity for the `itemId` and `uom` shipping to `locationId`, computed as `quantity_ordered - quantity_received`, clamped at `0`.
- `inTransit`: Received-but-not-posted/putaway quantity for the `itemId` and `uom` tied to `locationId` via `received_to_location_id` (fallback to PO `ship_to_location_id`), using accepted receipt qty minus posted putaway qty. Pending putaways remain in `inTransit`.
- `backordered`: Replenishment-only unmet demand bucket derived from live open demand at the same scope. It is kept separate from `reserved`.
- `inventoryPosition`: General snapshot coverage field. Replenishment planning does not rely on this field directly in this phase.

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

## Manufacturing Cost Integrity

- Work-order posting is ledger-authoritative and in-transaction: component issue consumption (`production_input`) and FG receipt layer creation happen in the same DB transaction.
- Canonical production valuation is FIFO layer-based. FG layers are created with unit cost derived from allocated component consumption value (not projector post-processing).
- Posting idempotency:
  - issue/completion posting uses deterministic movement source/idempotency keys scoped to the execution/issue id
  - batch posting supports request idempotency via `Idempotency-Key`; retries return the same movement ids and do not re-consume FIFO
  - `(tenant_id, Idempotency-Key)` is bound to a normalized batch payload hash (work order, occurredAt, consume/produce lines, override flags). Reusing a key with different payload fails with `WO_POSTING_IDEMPOTENCY_CONFLICT`.
  - replay completeness is explicit: if an idempotency record exists but execution/movement posting is incomplete, API returns `WO_POSTING_IDEMPOTENCY_INCOMPLETE` with missing execution ids.
- Conservation unit (DB check): deferred trigger compares execution-linked `cost_layer_consumptions` value (`consumption_type='production_input'`) against posted production `inventory_movement_lines` value for that execution’s production movement.
- Deferred DB conservation check (`WORK_ORDER_COST_CONSERVATION_FAILED`) enforces:
  - `total_component_cost = total_fg_cost + scrap_cost`
  - `fg_cost`/`scrap_cost` are split from positive production movement lines by `reason_code`
  - tolerance: absolute difference `<= 1e-6` (epsilon)
- Ops drift monitor: `scripts/inventory_invariants_check.mjs` section `work_order_cost_conservation_drift`.
- Scrap/reject accounting in conservation uses production movement line `reason_code` in:
  - `scrap`, `work_order_scrap`, `reject`, `work_order_reject`
  - these lines are counted as `scrap_cost`; other positive production lines are `fg_cost`
- Precision expectations: cost-layer and movement value fields are persisted as PostgreSQL `numeric` (scale-constrained columns), and conservation is validated with epsilon (`1e-6`) to avoid false failures on fractional allocations.
- Yield semantics: implicit yield transformations are allowed; if no explicit scrap/reject line is posted, any yield loss is reflected as higher FG unit cost while preserving total component value.
- WIP model: virtual linkage, not physical WIP stock. WIP value is represented by `cost_layer_consumptions.wip_execution_id` and execution/work-order WIP fields; value is allocated directly from issue consumptions to FG receipt in the same posting transaction.
- Projector guardrail: work-order movements must already have cost-layer activity when posted; projector is forbidden from creating manufacturing costs after commit.
- Reversal policy: work-order reversal is not supported in this phase. Corrective action must be posted as new ledger movements (never mutation of posted movements/lines).

## Relationships

- `available = onHand - reservedQty - allocatedQty`
- Snapshot `inventoryPosition` remains a shared read-model field.
- Replenishment planning uses `usableOnHand + onOrder + inTransit - reserved - backordered`.

## Warehouse Topology

- Canonical warehouse/location provisioning is defined in `seeds/topology/*.tsv`.
- `locations.code` is canonical (`UNIQUE (tenant_id, code)`); `locations.local_code` is warehouse-scoped bin label.
- Seed runner (check-only): `npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID>`.
- Seed runner repair mode: `npm run seed:warehouse-topology -- --tenant-id <TENANT_UUID> --fix`.
- Topology/default drift check: `warehouse_topology_defaults_invalid` section in `scripts/inventory_invariants_check.mjs`.
- Full reference: `docs/inventory/warehouse-topology.md`.

## Approximations & limitations

- `onOrder` uses approved / partially received PO outstanding quantity because shipment / ASN visibility does not exist in the current repo.
- WARNING: this may overstate inbound supply and delay replenishment triggers until shipment visibility is modeled explicitly.
- `inTransit` uses receipt lines where `received_to_location_id` (or PO `ship_to_location_id` if missing) matches the requested `locationId`, and counts accepted quantity minus posted putaway movements. If QC is on hold with no accepted qty, `inTransit` will be `0` for that line.
- `backordered` in replenishment is derived from live open demand and `usableOnHand`; it is not sourced from snapshot response fields.

## Glossary (API field → meaning)

- `itemId`: Item UUID (`items.id`), the canonical item key (not SKU).
- `locationId`: Location UUID (`locations.id`) — warehouse/bin/store/etc.
- `uom`: Unit of measure code used for the row.
- `onHand`: Posted physical quantity in ledger for that item/location/uom.
- `usableOnHand`: Sellable stock used only by replenishment evaluation.
- `reserved`: Snapshot-facing committed quantity (`RESERVED + ALLOCATED` open qty).
- `available`: ATP quantity; what remains to promise/consume.
- `onOrder`: Open PO quantity expected into that location/uom.
- `inTransit`: Received/accepted quantity not yet posted to inventory for that location/uom.
- `backordered`: Replenishment-only unmet demand kept separate from reserved commitment.
- `inventoryPosition`: Snapshot-facing coverage metric. Replenishment uses a separate internal position formula.

## Planning and replenishment (Phase 2)

- Position-based checks: `inventoryPosition` is the decision quantity for replenishment logic.
- Replenishment inventory position is computed internally as `usableOnHand + onOrder + inTransit - reserved - backordered`.
- Q/ROP: reorder when `inventoryPosition <= reorderPointQty`; recommended quantity uses fixed `orderQuantityQty` with min/max applied.
- Min-Max: reorder when `inventoryPosition <= reorderPointQty`; recommended quantity = `max(0, orderUpToLevelQty - inventoryPosition)` with min/max applied.
- Legacy `t_oul` is treated as a compatibility alias for Min-Max runtime behavior.
- Explicit `reorderPointQty` wins. If absent, reorder point is derived deterministically as `(demandRatePerDay * leadTimeDays) + fixedSafetyStockQty`.
- `ppis` is cycle coverage metadata, not safety stock, and does not inflate reorder point in this path.
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
- Snapshot API invariants remain specific to the snapshot read model.
- Replenishment invariants use `usableOnHand + onOrder + inTransit - reserved - backordered`.
- Missing sources imply `0` (never `null`)
- Query param UUIDs invalid → `400`; unknown `itemId`/`locationId` → `404`
