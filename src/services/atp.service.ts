import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';

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
  availableToPromise: number;
};

export type AtpQueryParams = {
  itemId?: string;
  locationId?: string;
  limit?: number;
  offset?: number;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

/**
 * Calculate Available to Promise (ATP) for inventory items.
 * ATP = on_hand - reserved
 * 
 * This provides a simplified view focused on ATP calculation,
 * excluding other inventory status fields like held, rejected, etc.
 */
export async function getAvailableToPromise(
  tenantId: string,
  params: AtpQueryParams = {}
): Promise<AtpResult[]> {
  const paramsList: any[] = [tenantId];
  const clauses: string[] = [];
  const reservedClauses: string[] = [];

  if (params.itemId) {
    clauses.push(`iml.item_id = $${paramsList.push(params.itemId)}`);
    reservedClauses.push(`r.item_id = $${paramsList.length}`);
  }
  if (params.locationId) {
    clauses.push(`iml.location_id = $${paramsList.push(params.locationId)}`);
    reservedClauses.push(`r.location_id = $${paramsList.length}`);
  }

  const limit = params.limit ?? 500;
  const offset = params.offset ?? 0;

  const whereOnHand = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const whereReserved = reservedClauses.length ? `AND ${reservedClauses.join(' AND ')}` : '';

  const { rows } = await query(
    `WITH on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.uom,
              SUM(iml.quantity_delta) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          ${whereOnHand}
        GROUP BY iml.item_id, iml.location_id, iml.uom
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              r.uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          ${whereReserved}
        GROUP BY r.item_id, r.location_id, r.uom
     ),
     combined AS (
       SELECT COALESCE(oh.item_id, rs.item_id) AS item_id,
              COALESCE(oh.location_id, rs.location_id) AS location_id,
              COALESCE(oh.uom, rs.uom) AS uom,
              COALESCE(oh.on_hand, 0) AS on_hand,
              COALESCE(rs.reserved, 0) AS reserved
         FROM on_hand oh
         FULL OUTER JOIN reserved rs
           ON oh.item_id = rs.item_id
          AND oh.location_id = rs.location_id
          AND oh.uom = rs.uom
     )
    SELECT c.item_id,
           i.sku AS item_sku,
           i.name AS item_name,
           c.location_id,
           l.code AS location_code,
           l.name AS location_name,
           c.uom,
           c.on_hand,
           c.reserved,
           (c.on_hand - c.reserved) AS available_to_promise
      FROM combined c
      JOIN items i ON i.item_id = c.item_id AND i.tenant_id = $1
      JOIN locations l ON l.location_id = c.location_id AND l.tenant_id = $1
     WHERE c.on_hand <> 0 OR c.reserved <> 0
     ORDER BY i.sku, l.code, c.uom
     LIMIT $${paramsList.push(limit)} OFFSET $${paramsList.push(offset)}`,
    paramsList
  );

  return rows.map((row: any) => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved),
    availableToPromise: normalizeQuantity(row.available_to_promise)
  }));
}

/**
 * Get ATP for a specific item/location/uom combination
 */
export async function getAvailableToPromiseDetail(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom?: string
): Promise<AtpResult | null> {
  const params: any[] = [tenantId, itemId, locationId];
  const uomFilter = uom ? `AND iml.uom = $${params.push(uom)}` : '';
  const uomFilterReserved = uom ? `AND r.uom = $${params.length}` : '';

  const { rows } = await query(
    `WITH on_hand AS (
       SELECT iml.uom,
              SUM(iml.quantity_delta) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = $2
          AND iml.location_id = $3
          ${uomFilter}
        GROUP BY iml.uom
     ),
     reserved AS (
       SELECT r.uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          AND r.item_id = $2
          AND r.location_id = $3
          ${uomFilterReserved}
        GROUP BY r.uom
     )
    SELECT i.sku AS item_sku,
           i.name AS item_name,
           l.code AS location_code,
           l.name AS location_name,
           COALESCE(oh.uom, rs.uom) AS uom,
           COALESCE(oh.on_hand, 0) AS on_hand,
           COALESCE(rs.reserved, 0) AS reserved,
           (COALESCE(oh.on_hand, 0) - COALESCE(rs.reserved, 0)) AS available_to_promise
      FROM on_hand oh
      FULL OUTER JOIN reserved rs ON oh.uom = rs.uom
      CROSS JOIN items i
      CROSS JOIN locations l
     WHERE (COALESCE(oh.on_hand, 0) <> 0 OR COALESCE(rs.reserved, 0) <> 0)
       AND i.item_id = $2 AND i.tenant_id = $1
       AND l.location_id = $3 AND l.tenant_id = $1`,
    params
  );

  if (rows.length === 0) return null;

  // If uom specified, return that specific row, otherwise return first
  const row = uom ? rows.find((r: any) => r.uom === uom) ?? rows[0] : rows[0];

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
    availableToPromise: normalizeQuantity(row.available_to_promise)
  };
}

/**
 * Check if sufficient ATP exists for a specific item/location/uom
 * Returns true if ATP >= requestedQuantity
 */
export async function checkAtpSufficiency(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string,
  requestedQuantity: number
): Promise<{ sufficient: boolean; atp: number; requested: number }> {
  const result = await getAvailableToPromiseDetail(tenantId, itemId, locationId, uom);
  
  const atp = result?.availableToPromise ?? 0;
  const sufficient = atp >= requestedQuantity;

  return {
    sufficient,
    atp,
    requested: requestedQuantity
  };
}
