import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  buildReplenishmentScopeKey,
  type ReplenishmentScope,
  type ReplenishmentInboundSupply,
  type ReplenishmentUsableSupply
} from './replenishmentPosition.service';

type DerivedBackorderBatchInput = {
  tenantId: string;
  keys: ReplenishmentScope[];
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

async function loadOpenDemandBatch(tenantId: string, scopeJson: ScopeJson[]) {
  // invariant: openDemand = ordered - fulfilled.
  // In this repo, fulfilled demand is measured from shipped quantities and
  // must match the reservation/backorder lifecycle.
  const [orderedRows, shippedRows] = await Promise.all([
    query(
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
       )
       SELECT k.warehouse_id,
              k.item_id,
              k.location_id,
              k.uom,
              COALESCE(
                SUM(
                  CASE
                    WHEN LOWER(sol.uom) = LOWER(k.uom) THEN sol.quantity_ordered
                    WHEN conv.factor IS NOT NULL THEN sol.quantity_ordered * conv.factor
                    ELSE 0
                  END
                ),
                0
              ) AS ordered_qty
         FROM input_keys k
         LEFT JOIN sales_orders so
           ON so.tenant_id = $1
          AND so.warehouse_id = k.warehouse_id
          AND so.ship_from_location_id = k.location_id
          AND so.status NOT IN ('draft', 'canceled', 'closed')
         LEFT JOIN sales_order_lines sol
           ON sol.tenant_id = so.tenant_id
          AND sol.sales_order_id = so.id
          AND sol.item_id = k.item_id
         LEFT JOIN uom_to_target conv
           ON conv.tenant_id = sol.tenant_id
          AND conv.item_id = sol.item_id
          AND conv.from_uom = LOWER(sol.uom)
          AND conv.to_uom = LOWER(k.uom)
        GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
      [tenantId, JSON.stringify(scopeJson)]
    ),
    query(
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
       )
       SELECT k.warehouse_id,
              k.item_id,
              k.location_id,
              k.uom,
              COALESCE(
                SUM(
                  CASE
                    WHEN LOWER(sosl.uom) = LOWER(k.uom) THEN sosl.quantity_shipped
                    WHEN conv.factor IS NOT NULL THEN sosl.quantity_shipped * conv.factor
                    ELSE 0
                  END
                ),
                0
              ) AS shipped_qty
         FROM input_keys k
         LEFT JOIN sales_order_shipments sos
           ON sos.tenant_id = $1
          AND sos.ship_from_location_id = k.location_id
         LEFT JOIN sales_orders so
           ON so.id = sos.sales_order_id
          AND so.tenant_id = sos.tenant_id
          AND so.warehouse_id = k.warehouse_id
         LEFT JOIN sales_order_shipment_lines sosl
           ON sosl.sales_order_shipment_id = sos.id
          AND sosl.tenant_id = sos.tenant_id
         LEFT JOIN sales_order_lines sol
           ON sol.id = sosl.sales_order_line_id
          AND sol.tenant_id = sosl.tenant_id
          AND sol.item_id = k.item_id
         LEFT JOIN uom_to_target conv
           ON conv.tenant_id = sol.tenant_id
          AND conv.item_id = sol.item_id
          AND conv.from_uom = LOWER(sosl.uom)
          AND conv.to_uom = LOWER(k.uom)
        GROUP BY k.warehouse_id, k.item_id, k.location_id, k.uom`,
      [tenantId, JSON.stringify(scopeJson)]
    )
  ]);

  const openDemandByScope = new Map<string, number>();
  for (const row of orderedRows.rows) {
    const scopeKey = buildReplenishmentScopeKey(tenantId, {
      warehouseId: row.warehouse_id,
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.uom
    });
    openDemandByScope.set(scopeKey, roundQuantity(toNumber(row.ordered_qty)));
  }

  for (const row of shippedRows.rows) {
    const scopeKey = buildReplenishmentScopeKey(tenantId, {
      warehouseId: row.warehouse_id,
      itemId: row.item_id,
      locationId: row.location_id,
      uom: row.uom
    });
    const ordered = openDemandByScope.get(scopeKey) ?? 0;
    openDemandByScope.set(scopeKey, roundQuantity(Math.max(0, ordered - toNumber(row.shipped_qty))));
  }

  return openDemandByScope;
}

export async function getDerivedBackorderBatch(input: DerivedBackorderBatchInput): Promise<Map<string, number>> {
  if (!input.keys.length) return new Map();
  // invariant: replenishment evaluation must not perform per-row DB queries.
  // all demand derivation must be batched.
  const scopeJson = buildScopeJson(input.keys);
  const openDemandByScope = await loadOpenDemandBatch(input.tenantId, scopeJson);

  const derivedByScope = new Map<string, number>();
  for (const key of input.keys) {
    const scopeKey = buildReplenishmentScopeKey(input.tenantId, key);
    const openDemand = openDemandByScope.get(scopeKey) ?? 0;
    const usableSupply = input.usableSupplyByScope.get(scopeKey) ?? {
      usableOnHand: 0,
      available: 0,
      reservedCommitment: 0
    };
    const inboundSupply = input.inboundSupplyByScope.get(scopeKey) ?? {
      onOrder: 0,
      inTransit: 0
    };
    // invariant: backorder derivation must use identical usable-supply logic
    // as replenishmentPosition.service.ts.
    // invariant: supply used in backorder derivation must match
    // replenishmentPosition.service.ts exactly.
    // invariant: supply inputs must be identical across position and
    // backorder derivation.
    // invariant: derived backorderedQty excludes reserved demand.
    // otherwise demand would be double-counted.
    const fulfillableSupply = Math.max(
      0,
      usableSupply.usableOnHand + inboundSupply.onOrder + inboundSupply.inTransit
    );
    const backordered = roundQuantity(Math.max(0, openDemand - fulfillableSupply));
    // invariant: derived backordered_qty must converge to 0 when demand is
    // fulfilled or supply becomes usable.
    derivedByScope.set(scopeKey, backordered);
  }

  return derivedByScope;
}
