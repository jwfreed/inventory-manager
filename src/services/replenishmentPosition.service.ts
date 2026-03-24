import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { sumReservedCommitment } from './replenishmentMath';

export type ReplenishmentScope = {
  warehouseId: string;
  itemId: string;
  locationId: string;
  uom: string;
};

export type ReplenishmentUsableSupply = {
  usableOnHand: number;
  available: number;
  reservedCommitment: number;
};

export type ReplenishmentInboundSupply = {
  onOrder: number;
  inTransit: number;
};

export type ReplenishmentPositionRow = ReplenishmentScope & {
  onHand: number;
  usableOnHand: number;
  reservedCommitment: number;
  available: number;
  onOrder: number;
  inTransit: number;
  openPurchaseSupply: number;
  acceptedPendingPutawaySupply: number;
  transferInboundSupply: number;
  qaHeldSupply: number;
  rejectedSupply: number;
};

export type ReplenishmentPositionBatchResult = {
  rows: ReplenishmentPositionRow[];
  positionByScope: Map<string, ReplenishmentPositionRow>;
  usableSupplyByScope: Map<string, ReplenishmentUsableSupply>;
  inboundSupplyByScope: Map<string, ReplenishmentInboundSupply>;
};

type ScopeJson = {
  warehouse_id: string;
  item_id: string;
  location_id: string;
  uom: string;
};

function normalizeUom(uom: string) {
  // invariant: all quantities must be in the same UOM.
  // no implicit unit conversion allowed.
  return String(uom ?? '').trim().toLowerCase();
}

export function buildReplenishmentScopeKey(tenantId: string, scope: ReplenishmentScope): string {
  return [
    tenantId,
    scope.warehouseId,
    scope.itemId,
    scope.locationId,
    normalizeUom(scope.uom)
  ].join(':');
}

function buildScopeJson(keys: ReplenishmentScope[]): ScopeJson[] {
  return Array.from(
    new Map(
      keys.map((key) => [
        `${key.warehouseId}:${key.itemId}:${key.locationId}:${normalizeUom(key.uom)}`,
        {
          warehouse_id: key.warehouseId,
          item_id: key.itemId,
          location_id: key.locationId,
          uom: normalizeUom(key.uom)
        }
      ])
    ).values()
  );
}

async function loadPhysicalOnHandBatch(tenantId: string, scopeJson: ScopeJson[]) {
  const { rows } = await query(
    `WITH input_keys AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS x(
           warehouse_id uuid,
           item_id uuid,
           location_id uuid,
           uom text
         )
     )
     SELECT k.warehouse_id,
            k.item_id,
            k.location_id,
            k.uom,
            COALESCE(SUM(v.on_hand_qty), 0) AS on_hand
       FROM input_keys k
       LEFT JOIN inventory_available_location_v v
         ON v.tenant_id = $1
        AND v.warehouse_id = k.warehouse_id
        AND v.item_id = k.item_id
        AND v.location_id = k.location_id
        AND LOWER(v.uom) = LOWER(k.uom)
      GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
    [tenantId, JSON.stringify(scopeJson)]
  );
  return new Map(
    rows.map((row: any) => [
      buildReplenishmentScopeKey(tenantId, {
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        locationId: row.location_id,
        uom: row.uom
      }),
      roundQuantity(toNumber(row.on_hand))
    ])
  );
}

async function loadUsableSupplyBatch(tenantId: string, scopeJson: ScopeJson[]) {
  // invariant: usableOnHand excludes non-sellable stock:
  // expired, QA hold, rejected, or non-allocatable inventory.
  // invariant: usableOnHand must exclude reserved/committed stock
  // otherwise fulfillableSupply will be overstated.
  const { rows } = await query(
    `WITH input_keys AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS x(
           warehouse_id uuid,
           item_id uuid,
           location_id uuid,
           uom text
         )
     )
     SELECT k.warehouse_id,
            k.item_id,
            k.location_id,
            k.uom,
            COALESCE(SUM(v.on_hand_qty), 0) AS usable_on_hand,
            COALESCE(SUM(v.reserved_qty), 0) AS reserved_qty,
            COALESCE(SUM(v.allocated_qty), 0) AS allocated_qty,
            COALESCE(SUM(v.available_qty), 0) AS available_qty
       FROM input_keys k
       LEFT JOIN inventory_available_location_sellable_v v
         ON v.tenant_id = $1
        AND v.warehouse_id = k.warehouse_id
        AND v.item_id = k.item_id
        AND v.location_id = k.location_id
        AND LOWER(v.uom) = LOWER(k.uom)
      GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
    [tenantId, JSON.stringify(scopeJson)]
  );

  return new Map(
    rows.map((row: any) => {
      const scope: ReplenishmentScope = {
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        locationId: row.location_id,
        uom: row.uom
      };
      return [
        buildReplenishmentScopeKey(tenantId, scope),
        {
          usableOnHand: roundQuantity(toNumber(row.usable_on_hand)),
          available: roundQuantity(toNumber(row.available_qty)),
          reservedCommitment: sumReservedCommitment(row.reserved_qty, row.allocated_qty)
        }
      ];
    })
  );
}

async function loadOpenPurchaseSupplyBatch(tenantId: string, scopeJson: ScopeJson[]) {
  const { rows } = await query(
    `WITH input_keys AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS x(
           warehouse_id uuid,
           item_id uuid,
           location_id uuid,
           uom text
         )
     ),
     uom_to_target AS (
       SELECT tenant_id,
              item_id,
              LOWER(from_uom) AS from_uom,
              LOWER(to_uom) AS to_uom,
              multiplier AS factor
         FROM item_uom_overrides
        WHERE active = true
        UNION ALL
       SELECT tenant_id,
              item_id,
              LOWER(to_uom) AS from_uom,
              LOWER(from_uom) AS to_uom,
              1 / multiplier AS factor
         FROM item_uom_overrides
        WHERE active = true
     ),
     received AS (
       SELECT purchase_order_line_id,
              SUM(quantity_received) AS total_received
         FROM purchase_order_receipt_lines
        GROUP BY purchase_order_line_id
     )
     SELECT k.warehouse_id,
            k.item_id,
            k.location_id,
            k.uom,
            COALESCE(
              SUM(
                CASE
                  WHEN LOWER(pol.uom) = LOWER(k.uom)
                    THEN GREATEST(pol.quantity_ordered - COALESCE(rec.total_received, 0), 0)
                  WHEN conv.factor IS NOT NULL
                    THEN GREATEST(pol.quantity_ordered - COALESCE(rec.total_received, 0), 0) * conv.factor
                  ELSE 0
                END
              ),
              0
            ) AS open_purchase_supply
       FROM input_keys k
       LEFT JOIN purchase_order_lines pol
         ON pol.tenant_id = $1
        AND pol.item_id = k.item_id
       LEFT JOIN purchase_orders po
         ON po.id = pol.purchase_order_id
        AND po.tenant_id = pol.tenant_id
       LEFT JOIN locations l
         ON l.id = po.ship_to_location_id
        AND l.tenant_id = po.tenant_id
       LEFT JOIN received rec
         ON rec.purchase_order_line_id = pol.id
       LEFT JOIN uom_to_target conv
         ON conv.tenant_id = pol.tenant_id
        AND conv.item_id = pol.item_id
        AND conv.from_uom = LOWER(pol.uom)
        AND conv.to_uom = LOWER(k.uom)
      WHERE po.tenant_id = $1
        AND po.ship_to_location_id = k.location_id
        AND l.warehouse_id = k.warehouse_id
        AND po.status IN ('approved', 'partially_received')
      GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
    [tenantId, JSON.stringify(scopeJson)]
  );

  return new Map(
    rows.map((row: any) => [
      buildReplenishmentScopeKey(tenantId, {
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        locationId: row.location_id,
        uom: row.uom
      }),
      roundQuantity(toNumber(row.open_purchase_supply))
    ])
  );
}

async function loadInboundBatch(
  tenantId: string,
  scopeJson: ScopeJson[]
) {
  const { rows } = await query(
    `WITH input_keys AS (
       SELECT *
         FROM jsonb_to_recordset($2::jsonb) AS x(
           warehouse_id uuid,
           item_id uuid,
           location_id uuid,
           uom text
         )
     ),
     uom_to_target AS (
       SELECT tenant_id,
              item_id,
              LOWER(from_uom) AS from_uom,
              LOWER(to_uom) AS to_uom,
              multiplier AS factor
         FROM item_uom_overrides
        WHERE active = true
        UNION ALL
       SELECT tenant_id,
              item_id,
              LOWER(to_uom) AS from_uom,
              LOWER(from_uom) AS to_uom,
              1 / multiplier AS factor
         FROM item_uom_overrides
        WHERE active = true
     ),
     qc AS (
       SELECT purchase_order_receipt_line_id,
              SUM(CASE WHEN event_type = 'accept' THEN quantity ELSE 0 END) AS accept_qty,
              SUM(CASE WHEN event_type = 'hold' THEN quantity ELSE 0 END) AS hold_qty,
              SUM(CASE WHEN event_type = 'reject' THEN quantity ELSE 0 END) AS reject_qty
         FROM qc_events
        WHERE tenant_id = $1
        GROUP BY purchase_order_receipt_line_id
     ),
     putaway AS (
       SELECT purchase_order_receipt_line_id,
              SUM(CASE WHEN status = 'completed' THEN COALESCE(quantity_moved, 0) ELSE 0 END) AS posted_qty
         FROM putaway_lines
        WHERE tenant_id = $1
          AND status <> 'canceled'
        GROUP BY purchase_order_receipt_line_id
     )
     SELECT k.warehouse_id,
            k.item_id,
            k.location_id,
            k.uom,
            COALESCE(
              SUM(
                CASE
                  WHEN LOWER(prl.uom) = LOWER(k.uom) THEN
                    GREATEST(
                      CASE
                        WHEN COALESCE(qc.accept_qty, 0) > 0 THEN COALESCE(qc.accept_qty, 0)
                        WHEN COALESCE(qc.hold_qty, 0) > 0 THEN 0
                        ELSE GREATEST(prl.quantity_received - COALESCE(qc.reject_qty, 0), 0)
                      END - COALESCE(putaway.posted_qty, 0),
                      0
                    )
                  WHEN conv.factor IS NOT NULL THEN
                    GREATEST(
                      CASE
                        WHEN COALESCE(qc.accept_qty, 0) > 0 THEN COALESCE(qc.accept_qty, 0)
                        WHEN COALESCE(qc.hold_qty, 0) > 0 THEN 0
                        ELSE GREATEST(prl.quantity_received - COALESCE(qc.reject_qty, 0), 0)
                      END - COALESCE(putaway.posted_qty, 0),
                      0
                    ) * conv.factor
                  ELSE 0
                END
              ),
              0
            ) AS accepted_pending_putaway_supply,
            COALESCE(
              SUM(
                CASE
                  WHEN LOWER(prl.uom) = LOWER(k.uom) THEN COALESCE(qc.hold_qty, 0)
                  WHEN conv.factor IS NOT NULL THEN COALESCE(qc.hold_qty, 0) * conv.factor
                  ELSE 0
                END
              ),
              0
            ) AS qa_held_supply,
            COALESCE(
              SUM(
                CASE
                  WHEN LOWER(prl.uom) = LOWER(k.uom) THEN COALESCE(qc.reject_qty, 0)
                  WHEN conv.factor IS NOT NULL THEN COALESCE(qc.reject_qty, 0) * conv.factor
                  ELSE 0
                END
              ),
              0
            ) AS rejected_supply
       FROM input_keys k
       LEFT JOIN purchase_order_lines pol
         ON pol.tenant_id = $1
        AND pol.item_id = k.item_id
       LEFT JOIN purchase_order_receipt_lines prl
         ON prl.purchase_order_line_id = pol.id
        AND prl.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipts por
         ON por.id = prl.purchase_order_receipt_id
        AND por.tenant_id = prl.tenant_id
       LEFT JOIN purchase_orders po
         ON po.id = pol.purchase_order_id
        AND po.tenant_id = pol.tenant_id
       LEFT JOIN locations l
         ON l.id = COALESCE(por.received_to_location_id, po.ship_to_location_id)
        AND l.tenant_id = po.tenant_id
       LEFT JOIN qc
         ON qc.purchase_order_receipt_line_id = prl.id
       LEFT JOIN putaway
         ON putaway.purchase_order_receipt_line_id = prl.id
       LEFT JOIN uom_to_target conv
         ON conv.tenant_id = pol.tenant_id
        AND conv.item_id = pol.item_id
        AND conv.from_uom = LOWER(prl.uom)
        AND conv.to_uom = LOWER(k.uom)
      WHERE por.tenant_id = $1
        AND por.status <> 'voided'
        AND COALESCE(por.received_to_location_id, po.ship_to_location_id) = k.location_id
        AND l.warehouse_id = k.warehouse_id
      GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
    [tenantId, JSON.stringify(scopeJson)]
  );

  return new Map(
    rows.map((row: any) => [
      buildReplenishmentScopeKey(tenantId, {
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        locationId: row.location_id,
        uom: row.uom
      }),
      {
        acceptedPendingPutawaySupply: roundQuantity(toNumber(row.accepted_pending_putaway_supply)),
        qaHeldSupply: roundQuantity(toNumber(row.qa_held_supply)),
        rejectedSupply: roundQuantity(toNumber(row.rejected_supply))
      }
    ])
  );
}

export async function loadReplenishmentPositionBatch(
  tenantId: string,
  keys: ReplenishmentScope[]
): Promise<ReplenishmentPositionBatchResult> {
  if (!keys.length) {
    return {
      rows: [],
      positionByScope: new Map(),
      usableSupplyByScope: new Map(),
      inboundSupplyByScope: new Map()
    };
  }

  const scopeJson = buildScopeJson(keys);
  const [physicalOnHandByScope, usableSupplyByScope, openPurchaseSupplyByScope, inboundByScope] =
    await Promise.all([
      loadPhysicalOnHandBatch(tenantId, scopeJson),
      loadUsableSupplyBatch(tenantId, scopeJson),
      loadOpenPurchaseSupplyBatch(tenantId, scopeJson),
      loadInboundBatch(tenantId, scopeJson)
    ]);

  const positionByScope = new Map<string, ReplenishmentPositionRow>();
  const inboundSupplyByScope = new Map<string, ReplenishmentInboundSupply>();
  const rows: ReplenishmentPositionRow[] = [];

  for (const key of keys) {
    const scopeKey = buildReplenishmentScopeKey(tenantId, key);
    const usableSupply = usableSupplyByScope.get(scopeKey) ?? {
      usableOnHand: 0,
      available: 0,
      reservedCommitment: 0
    };
    const inbound = inboundByScope.get(scopeKey) ?? {
      acceptedPendingPutawaySupply: 0,
      qaHeldSupply: 0,
      rejectedSupply: 0
    };
    const openPurchaseSupply = openPurchaseSupplyByScope.get(scopeKey) ?? 0;
    const row: ReplenishmentPositionRow = {
      ...key,
      onHand: physicalOnHandByScope.get(scopeKey) ?? 0,
      usableOnHand: usableSupply.usableOnHand,
      reservedCommitment: usableSupply.reservedCommitment,
      available: usableSupply.available,
      // WARNING: approved PO is used as inbound approximation.
      // may overstate supply due to lack of shipment visibility.
      onOrder: openPurchaseSupply,
      inTransit: inbound.acceptedPendingPutawaySupply,
      openPurchaseSupply,
      acceptedPendingPutawaySupply: inbound.acceptedPendingPutawaySupply,
      // TODO: if a transfer pipeline entity is introduced, include inbound
      // transfer supply in replenishment position.
      transferInboundSupply: 0,
      qaHeldSupply: inbound.qaHeldSupply,
      rejectedSupply: inbound.rejectedSupply
    };
    rows.push(row);
    positionByScope.set(scopeKey, row);
    inboundSupplyByScope.set(scopeKey, {
      onOrder: row.onOrder,
      inTransit: row.inTransit
    });
  }

  return { rows, positionByScope, usableSupplyByScope, inboundSupplyByScope };
}
