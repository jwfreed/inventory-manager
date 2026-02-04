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
  allocated: number;
  availableToPromise: number;
};

export type AtpQueryParams = {
  itemId?: string;
  locationId?: string;
  limit?: number;
  offset?: number;
};

export type SellableSupply = {
  onHand: number;
  reserved: number;
  allocated: number;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

const SELLABLE_LOCATION_FILTER = `AND l.is_sellable = true`;

export async function getSellableSupplyMap(
  tenantId: string,
  params: { itemIds: string[]; locationId?: string }
): Promise<Map<string, SellableSupply>> {
  if (!params.itemIds.length) return new Map();
  const paramList: any[] = [tenantId, params.itemIds];
  const locationParam = params.locationId ? paramList.push(params.locationId) : null;
  const locationClause = locationParam ? `AND iml.location_id = $${locationParam}` : '';
  const locationClauseReserved = locationParam ? `AND r.location_id = $${locationParam}` : '';

  const { rows } = await query(
    `WITH on_hand_base AS (
       SELECT iml.item_id,
              COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = ANY($2)
          ${locationClause}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY iml.item_id, COALESCE(iml.canonical_uom, iml.uom)
     ),
     expired_lots AS (
       SELECT iml.item_id,
              COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(imlot.quantity_delta) AS expired_qty
         FROM inventory_movement_lots imlot
         JOIN inventory_movement_lines iml ON iml.id = imlot.inventory_movement_line_id
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
         JOIN lots lot ON lot.id = imlot.lot_id AND lot.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = ANY($2)
          ${locationClause}
          ${SELLABLE_LOCATION_FILTER}
          AND lot.expires_at IS NOT NULL
          AND lot.expires_at::date < CURRENT_DATE
        GROUP BY iml.item_id, COALESCE(iml.canonical_uom, iml.uom)
     ),
     on_hand AS (
       SELECT oh.item_id,
              oh.uom,
              GREATEST(0, oh.on_hand - COALESCE(el.expired_qty, 0)) AS on_hand
         FROM on_hand_base oh
         LEFT JOIN expired_lots el
           ON el.item_id = oh.item_id
          AND el.uom = oh.uom
     ),
     reserved_allocated AS (
       SELECT r.item_id,
              COALESCE(i.canonical_uom, r.uom) AS uom,
              SUM(
                CASE
                  WHEN r.status = 'RESERVED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS reserved,
              SUM(
                CASE
                  WHEN r.status = 'ALLOCATED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS allocated
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
         JOIN locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
        WHERE r.status IN ('RESERVED', 'ALLOCATED')
          AND r.tenant_id = $1
          AND r.item_id = ANY($2)
          AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
          ${locationClauseReserved}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY r.item_id, COALESCE(i.canonical_uom, r.uom)
     ),
     combined AS (
       SELECT COALESCE(oh.item_id, ra.item_id) AS item_id,
              COALESCE(oh.uom, ra.uom) AS uom,
              COALESCE(oh.on_hand, 0) AS on_hand,
              COALESCE(ra.reserved, 0) AS reserved,
              COALESCE(ra.allocated, 0) AS allocated
         FROM on_hand oh
         FULL OUTER JOIN reserved_allocated ra
           ON oh.item_id = ra.item_id
          AND oh.uom = ra.uom
     )
    SELECT item_id, uom, on_hand, reserved, allocated
      FROM combined
     WHERE on_hand <> 0 OR reserved <> 0 OR allocated <> 0`,
    paramList
  );

  const map = new Map<string, SellableSupply>();
  for (const row of rows) {
    map.set(`${row.item_id}:${row.uom}`, {
      onHand: normalizeQuantity(row.on_hand),
      reserved: normalizeQuantity(row.reserved),
      allocated: normalizeQuantity(row.allocated)
    });
  }
  return map;
}

/**
 * Calculate Available to Promise (ATP) for inventory items.
 * ATP = on_hand - reserved - allocated
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

  const { rows } = await query(
    `WITH on_hand_base AS (
       SELECT iml.item_id,
              iml.location_id,
              COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          ${whereOnHand}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY iml.item_id, iml.location_id, COALESCE(iml.canonical_uom, iml.uom)
     ),
     expired_lots AS (
       SELECT iml.item_id,
              iml.location_id,
              COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(imlot.quantity_delta) AS expired_qty
         FROM inventory_movement_lots imlot
         JOIN inventory_movement_lines iml ON iml.id = imlot.inventory_movement_line_id
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
         JOIN lots lot ON lot.id = imlot.lot_id AND lot.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          ${whereOnHand}
          ${SELLABLE_LOCATION_FILTER}
          AND lot.expires_at IS NOT NULL
          AND lot.expires_at::date < CURRENT_DATE
        GROUP BY iml.item_id, iml.location_id, COALESCE(iml.canonical_uom, iml.uom)
     ),
     on_hand AS (
       SELECT oh.item_id,
              oh.location_id,
              oh.uom,
              GREATEST(0, oh.on_hand - COALESCE(el.expired_qty, 0)) AS on_hand
         FROM on_hand_base oh
         LEFT JOIN expired_lots el
           ON el.item_id = oh.item_id
          AND el.location_id = oh.location_id
          AND el.uom = oh.uom
     ),
     reserved_allocated AS (
       SELECT r.item_id,
              r.location_id,
              COALESCE(i.canonical_uom, r.uom) AS uom,
              SUM(
                CASE
                  WHEN r.status = 'RESERVED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS reserved,
              SUM(
                CASE
                  WHEN r.status = 'ALLOCATED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS allocated
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
         JOIN locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
        WHERE r.status IN ('RESERVED', 'ALLOCATED')
          AND r.tenant_id = $1
          AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
          ${whereReserved}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY r.item_id, r.location_id, COALESCE(i.canonical_uom, r.uom)
     ),
     combined AS (
       SELECT COALESCE(oh.item_id, ra.item_id) AS item_id,
              COALESCE(oh.location_id, ra.location_id) AS location_id,
              COALESCE(oh.uom, ra.uom) AS uom,
              COALESCE(oh.on_hand, 0) AS on_hand,
              COALESCE(ra.reserved, 0) AS reserved,
              COALESCE(ra.allocated, 0) AS allocated
         FROM on_hand oh
         FULL OUTER JOIN reserved_allocated ra
           ON oh.item_id = ra.item_id
          AND oh.location_id = ra.location_id
          AND oh.uom = ra.uom
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
           c.allocated,
           (c.on_hand - c.reserved - c.allocated) AS available_to_promise
      FROM combined c
      JOIN items i ON i.id = c.item_id AND i.tenant_id = $1
      JOIN locations l ON l.id = c.location_id AND l.tenant_id = $1
     WHERE c.on_hand <> 0 OR c.reserved <> 0 OR c.allocated <> 0
     ORDER BY i.sku, l.code, c.uom
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    paramsList
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
  const uomFilter = uom ? `AND COALESCE(iml.canonical_uom, iml.uom) = $${params.push(uom)}` : '';
  const uomFilterReserved = uom ? `AND COALESCE(i.canonical_uom, r.uom) = $${params.length}` : '';

  const { rows } = await query(
    `WITH on_hand_base AS (
       SELECT COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)) AS on_hand
         FROM inventory_movement_lines iml
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = $2
          AND iml.location_id = $3
          ${uomFilter}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY COALESCE(iml.canonical_uom, iml.uom)
     ),
     expired_lots AS (
       SELECT COALESCE(iml.canonical_uom, iml.uom) AS uom,
              SUM(imlot.quantity_delta) AS expired_qty
         FROM inventory_movement_lots imlot
         JOIN inventory_movement_lines iml ON iml.id = imlot.inventory_movement_line_id
         JOIN inventory_movements im ON im.id = iml.movement_id
         JOIN locations l ON l.id = iml.location_id AND l.tenant_id = iml.tenant_id
         JOIN lots lot ON lot.id = imlot.lot_id AND lot.tenant_id = iml.tenant_id
        WHERE im.status = 'posted'
          AND iml.tenant_id = $1
          AND im.tenant_id = $1
          AND iml.item_id = $2
          AND iml.location_id = $3
          ${uomFilter}
          ${SELLABLE_LOCATION_FILTER}
          AND lot.expires_at IS NOT NULL
          AND lot.expires_at::date < CURRENT_DATE
        GROUP BY COALESCE(iml.canonical_uom, iml.uom)
     ),
     on_hand AS (
       SELECT oh.uom,
              GREATEST(0, oh.on_hand - COALESCE(el.expired_qty, 0)) AS on_hand
         FROM on_hand_base oh
         LEFT JOIN expired_lots el
           ON el.uom = oh.uom
     ),
     reserved_allocated AS (
       SELECT COALESCE(i.canonical_uom, r.uom) AS uom,
              SUM(
                CASE
                  WHEN r.status = 'RESERVED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS reserved,
              SUM(
                CASE
                  WHEN r.status = 'ALLOCATED'
                  THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                  ELSE 0
                END
              ) AS allocated
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
         JOIN locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
        WHERE r.status IN ('RESERVED', 'ALLOCATED')
          AND r.tenant_id = $1
          AND r.item_id = $2
          AND r.location_id = $3
          AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
          ${uomFilterReserved}
          ${SELLABLE_LOCATION_FILTER}
        GROUP BY COALESCE(i.canonical_uom, r.uom)
     )
    SELECT i.sku AS item_sku,
           i.name AS item_name,
           l.code AS location_code,
           l.name AS location_name,
           COALESCE(oh.uom, ra.uom) AS uom,
           COALESCE(oh.on_hand, 0) AS on_hand,
           COALESCE(ra.reserved, 0) AS reserved,
           COALESCE(ra.allocated, 0) AS allocated,
           (COALESCE(oh.on_hand, 0) - COALESCE(ra.reserved, 0) - COALESCE(ra.allocated, 0)) AS available_to_promise
      FROM on_hand oh
      FULL OUTER JOIN reserved_allocated ra ON oh.uom = ra.uom
      CROSS JOIN items i
      CROSS JOIN locations l
     WHERE (COALESCE(oh.on_hand, 0) <> 0 OR COALESCE(ra.reserved, 0) <> 0 OR COALESCE(ra.allocated, 0) <> 0)
       AND i.id = $2 AND i.tenant_id = $1
       AND l.id = $3 AND l.tenant_id = $1`,
    params
  );

  if (rows.length > 0) {
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
  return null;
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
