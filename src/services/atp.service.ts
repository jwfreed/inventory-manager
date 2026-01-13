import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { atpCache, cacheKey } from '../lib/cache';

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
  isLegacy?: boolean;
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
 * 
 * Results are cached for 30 seconds to reduce database load.
 */
export async function getAvailableToPromise(
  tenantId: string,
  params: AtpQueryParams = {}
): Promise<AtpResult[]> {
  // Check cache first
  const key = cacheKey('atp', tenantId, params as Record<string, unknown>);
  const cached = atpCache.get(key) as AtpResult[] | undefined;
  if (cached) return cached;

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

  const limitParam = paramsList.push(limit);
  const offsetParam = paramsList.push(offset);

  const { rows: canonicalRows } = await query(
    `WITH on_hand AS (
       SELECT iml.item_id,
              iml.location_id,
              iml.canonical_uom AS uom,
              SUM(iml.quantity_delta_canonical) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.quantity_delta_canonical IS NOT NULL
          ${whereOnHand}
        GROUP BY iml.item_id, iml.location_id, iml.canonical_uom
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              i.canonical_uom AS uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          AND i.canonical_uom IS NOT NULL
          AND r.uom = i.canonical_uom
          ${whereReserved}
        GROUP BY r.item_id, r.location_id, i.canonical_uom
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
           (c.on_hand - c.reserved) AS available_to_promise,
           false AS is_legacy
      FROM combined c
      JOIN items i ON i.id = c.item_id AND i.tenant_id = $1
      JOIN locations l ON l.id = c.location_id AND l.tenant_id = $1
     WHERE c.on_hand <> 0 OR c.reserved <> 0
     ORDER BY i.sku, l.code, c.uom
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    paramsList
  );

  const canonicalKeys = new Set(
    canonicalRows.map((row: any) => `${row.item_id}:${row.location_id}`)
  );

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
          AND iml.quantity_delta_canonical IS NULL
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
           (c.on_hand - c.reserved) AS available_to_promise,
           true AS is_legacy
      FROM combined c
      JOIN items i ON i.id = c.item_id AND i.tenant_id = $1
      JOIN locations l ON l.id = c.location_id AND l.tenant_id = $1
     WHERE c.on_hand <> 0 OR c.reserved <> 0
     ORDER BY i.sku, l.code, c.uom
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    paramsList
  );

  const legacyResults = rows
    .map((row: any) => ({
      itemId: row.item_id,
      itemSku: row.item_sku,
      itemName: row.item_name,
      locationId: row.location_id,
      locationCode: row.location_code,
      locationName: row.location_name,
      uom: row.uom,
      onHand: normalizeQuantity(row.on_hand),
      reserved: normalizeQuantity(row.reserved),
      availableToPromise: normalizeQuantity(row.available_to_promise),
      isLegacy: row.is_legacy
    }))
    .filter((row) => !canonicalKeys.has(`${row.itemId}:${row.locationId}`));

  const canonicalResults = canonicalRows.map((row: any) => ({
    itemId: row.item_id,
    itemSku: row.item_sku,
    itemName: row.item_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationName: row.location_name,
    uom: row.uom,
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved),
    availableToPromise: normalizeQuantity(row.available_to_promise),
    isLegacy: row.is_legacy
  }));

  const results = [...canonicalResults, ...legacyResults];

  // Cache results for 30 seconds
  atpCache.set(key, results);
  
  return results;
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
  const uomFilter = uom ? `AND iml.canonical_uom = $${params.push(uom)}` : '';
  const uomFilterReserved = uom ? `AND i.canonical_uom = $${params.length}` : '';

  const { rows: canonicalRows } = await query(
    `WITH on_hand AS (
       SELECT iml.canonical_uom AS uom,
              SUM(iml.quantity_delta_canonical) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = $2
          AND iml.location_id = $3
          AND iml.quantity_delta_canonical IS NOT NULL
          ${uomFilter}
        GROUP BY iml.canonical_uom
     ),
     reserved AS (
       SELECT i.canonical_uom AS uom,
              SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
        WHERE r.status IN ('open', 'released')
          AND r.tenant_id = $1
          AND r.item_id = $2
          AND r.location_id = $3
          AND i.canonical_uom IS NOT NULL
          AND r.uom = i.canonical_uom
          ${uomFilterReserved}
        GROUP BY i.canonical_uom
     )
    SELECT i.sku AS item_sku,
           i.name AS item_name,
           l.code AS location_code,
           l.name AS location_name,
           COALESCE(oh.uom, rs.uom) AS uom,
           COALESCE(oh.on_hand, 0) AS on_hand,
           COALESCE(rs.reserved, 0) AS reserved,
           (COALESCE(oh.on_hand, 0) - COALESCE(rs.reserved, 0)) AS available_to_promise,
           false AS is_legacy
      FROM on_hand oh
      FULL OUTER JOIN reserved rs ON oh.uom = rs.uom
      CROSS JOIN items i
      CROSS JOIN locations l
     WHERE (COALESCE(oh.on_hand, 0) <> 0 OR COALESCE(rs.reserved, 0) <> 0)
       AND i.id = $2 AND i.tenant_id = $1
       AND l.id = $3 AND l.tenant_id = $1`,
    params
  );

  if (canonicalRows.length > 0) {
    const row = canonicalRows[0];
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
      availableToPromise: normalizeQuantity(row.available_to_promise),
      isLegacy: row.is_legacy
    };
  }

  const legacyParams: any[] = [tenantId, itemId, locationId];
  const legacyUomFilter = uom ? `AND iml.uom = $${legacyParams.push(uom)}` : '';
  const legacyUomFilterReserved = uom ? `AND r.uom = $${legacyParams.length}` : '';

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
          AND iml.quantity_delta_canonical IS NULL
          ${legacyUomFilter}
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
          ${legacyUomFilterReserved}
        GROUP BY r.uom
     )
    SELECT i.sku AS item_sku,
           i.name AS item_name,
           l.code AS location_code,
           l.name AS location_name,
           COALESCE(oh.uom, rs.uom) AS uom,
           COALESCE(oh.on_hand, 0) AS on_hand,
           COALESCE(rs.reserved, 0) AS reserved,
           (COALESCE(oh.on_hand, 0) - COALESCE(rs.reserved, 0)) AS available_to_promise,
           true AS is_legacy
      FROM on_hand oh
      FULL OUTER JOIN reserved rs ON oh.uom = rs.uom
      CROSS JOIN items i
      CROSS JOIN locations l
     WHERE (COALESCE(oh.on_hand, 0) <> 0 OR COALESCE(rs.reserved, 0) <> 0)
       AND i.id = $2 AND i.tenant_id = $1
       AND l.id = $3 AND l.tenant_id = $1`,
    legacyParams
  );

  if (rows.length === 0) return null;

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
    availableToPromise: normalizeQuantity(row.available_to_promise),
    isLegacy: row.is_legacy
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
