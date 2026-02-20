import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { getAtpCacheValue, setAtpCacheValue } from './atpCache.service';

export type AtpResult = {
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  uom: string;
  onHand: number;
  reserved: number;
  allocated: number;
  availableToPromise: number;
};

export type AtpQueryParams = {
  warehouseId: string;
  itemId?: string;
  locationId?: string;
  limit?: number;
  offset?: number;
};

export type SellableSupply = {
  onHand: number;
  reserved: number;
  allocated: number;
  available: number;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

export async function getSellableSupplyMap(
  tenantId: string,
  params: { warehouseId: string; itemIds: string[]; locationId?: string }
): Promise<Map<string, SellableSupply>> {
  if (!params.itemIds.length) return new Map();

  const sqlParams: any[] = [tenantId, params.warehouseId, params.itemIds];
  const whereLocation = params.locationId ? `AND v.location_id = $${sqlParams.push(params.locationId)}` : '';

  const { rows } = await query(
    `SELECT v.item_id,
            v.uom,
            SUM(v.on_hand_qty) AS on_hand,
            SUM(v.reserved_qty) AS reserved,
            SUM(v.allocated_qty) AS allocated,
            SUM(v.available_qty) AS available
       FROM inventory_available_location_sellable_v v
      WHERE v.tenant_id = $1
        AND v.warehouse_id = $2
        AND v.item_id = ANY($3::uuid[])
        ${whereLocation}
      GROUP BY v.item_id, v.uom`,
    sqlParams
  );

  const map = new Map<string, SellableSupply>();
  for (const row of rows) {
    map.set(`${row.item_id}:${row.uom}`, {
      onHand: normalizeQuantity(row.on_hand),
      reserved: normalizeQuantity(row.reserved),
      allocated: normalizeQuantity(row.allocated),
      available: normalizeQuantity(row.available)
    });
  }
  return map;
}

export async function getAvailableToPromise(
  tenantId: string,
  params: AtpQueryParams
): Promise<AtpResult[]> {
  const cached = getAtpCacheValue<AtpResult[]>(tenantId, params.warehouseId, {
    itemId: params.itemId,
    locationId: params.locationId,
    limit: params.limit,
    offset: params.offset
  });
  if (cached) return cached;

  const sqlParams: any[] = [tenantId, params.warehouseId];
  const clauses: string[] = [];

  if (params.itemId) {
    clauses.push(`v.item_id = $${sqlParams.push(params.itemId)}`);
  }
  if (params.locationId) {
    clauses.push(`v.location_id = $${sqlParams.push(params.locationId)}`);
  }

  const limitParam = sqlParams.push(params.limit ?? 500);
  const offsetParam = sqlParams.push(params.offset ?? 0);
  const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT v.item_id,
            i.sku AS item_sku,
            i.name AS item_name,
            v.location_id,
            l.code AS location_code,
            l.name AS location_name,
            v.uom,
            v.on_hand_qty AS on_hand,
            v.reserved_qty AS reserved,
            v.allocated_qty AS allocated,
            v.available_qty AS available_to_promise
       FROM inventory_available_location_sellable_v v
       JOIN items i
         ON i.id = v.item_id
        AND i.tenant_id = v.tenant_id
       JOIN locations l
         ON l.id = v.location_id
        AND l.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1
        AND v.warehouse_id = $2
        ${where}
        AND (v.on_hand_qty <> 0 OR v.reserved_qty <> 0 OR v.allocated_qty <> 0)
      ORDER BY i.sku, l.code, v.uom
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    sqlParams
  );

  const results = rows.map((row: any) => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved),
    allocated: normalizeQuantity(row.allocated),
    availableToPromise: normalizeQuantity(row.available_to_promise)
  }));

  setAtpCacheValue(
    tenantId,
    params.warehouseId,
    {
      itemId: params.itemId,
      locationId: params.locationId,
      limit: params.limit,
      offset: params.offset
    },
    results
  );
  return results;
}

export async function getAvailableToPromiseDetail(
  tenantId: string,
  warehouseId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<AtpResult | null> {
  const sqlParams: any[] = [tenantId, warehouseId, itemId, locationId];
  const whereUom = uom ? `AND v.uom = $${sqlParams.push(uom)}` : '';

  const { rows } = await query(
    `SELECT i.sku AS item_sku,
            i.name AS item_name,
            l.code AS location_code,
            l.name AS location_name,
            v.uom,
            v.on_hand_qty AS on_hand,
            v.reserved_qty AS reserved,
            v.allocated_qty AS allocated,
            v.available_qty AS available_to_promise
       FROM inventory_available_location_sellable_v v
       JOIN items i
         ON i.id = v.item_id
        AND i.tenant_id = v.tenant_id
       JOIN locations l
         ON l.id = v.location_id
        AND l.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1
        AND v.warehouse_id = $2
        AND v.item_id = $3
        AND v.location_id = $4
        ${whereUom}
        AND (v.on_hand_qty <> 0 OR v.reserved_qty <> 0 OR v.allocated_qty <> 0)
      ORDER BY v.uom
      LIMIT 1`,
    sqlParams
  );

  if (!rows.length) return null;
  const row = rows[0];
  return {
    itemId,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved),
    allocated: normalizeQuantity(row.allocated),
    availableToPromise: normalizeQuantity(row.available_to_promise)
  };
}

export async function checkAtpSufficiency(
  tenantId: string,
  warehouseId: string,
  itemId: string,
  locationId: string,
  uom: string,
  requestedQuantity: number
): Promise<{ sufficient: boolean; atp: number; requested: number }> {
  const result = await getAvailableToPromiseDetail(tenantId, warehouseId, itemId, locationId, uom);
  const atp = result?.availableToPromise ?? 0;
  return {
    sufficient: atp >= requestedQuantity,
    atp,
    requested: requestedQuantity
  };
}
