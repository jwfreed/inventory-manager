import { query } from '../db';

export async function assertItemExists(tenantId: string, id: string) {
  const res = await query('SELECT 1 FROM items WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return (res.rowCount ?? 0) > 0;
}

export async function assertLocationExists(tenantId: string, id: string) {
  const res = await query('SELECT 1 FROM locations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return (res.rowCount ?? 0) > 0;
}

export async function getItemInventorySummary(tenantId: string, itemId: string) {
  const { rows: canonicalRows } = await query(
    `SELECT iml.location_id, iml.canonical_uom AS uom, SUM(iml.quantity_delta_canonical) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.item_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
       AND iml.quantity_delta_canonical IS NOT NULL
     GROUP BY iml.location_id, iml.canonical_uom
     HAVING SUM(iml.quantity_delta_canonical) <> 0
     ORDER BY iml.location_id ASC, iml.canonical_uom ASC`,
    [itemId, tenantId]
  );
  const canonicalLocations = new Set(canonicalRows.map((row) => row.location_id));
  const { rows: legacyRows } = await query(
    `SELECT iml.location_id, iml.uom, SUM(iml.quantity_delta) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.item_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
       AND iml.quantity_delta_canonical IS NULL
     GROUP BY iml.location_id, iml.uom
     HAVING SUM(iml.quantity_delta) <> 0
     ORDER BY iml.location_id ASC, iml.uom ASC`,
    [itemId, tenantId]
  );
  const canonicalMapped = canonicalRows.map((row) => ({
    locationId: row.location_id,
    uom: row.uom,
    onHand: row.on_hand,
    isLegacy: false
  }));
  const legacyMapped = legacyRows
    .filter((row) => !canonicalLocations.has(row.location_id))
    .map((row) => ({
      locationId: row.location_id,
      uom: row.uom,
      onHand: row.on_hand,
      isLegacy: true
    }));
  return [...canonicalMapped, ...legacyMapped];
}

export async function getLocationInventorySummary(tenantId: string, locationId: string) {
  const { rows: canonicalRows } = await query(
    `SELECT iml.item_id, iml.canonical_uom AS uom, SUM(iml.quantity_delta_canonical) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.location_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
       AND iml.quantity_delta_canonical IS NOT NULL
     GROUP BY iml.item_id, iml.canonical_uom
     HAVING SUM(iml.quantity_delta_canonical) <> 0
     ORDER BY iml.item_id ASC, iml.canonical_uom ASC`,
    [locationId, tenantId]
  );
  const canonicalItems = new Set(canonicalRows.map((row) => row.item_id));
  const { rows: legacyRows } = await query(
    `SELECT iml.item_id, iml.uom, SUM(iml.quantity_delta) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.location_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
       AND iml.quantity_delta_canonical IS NULL
     GROUP BY iml.item_id, iml.uom
     HAVING SUM(iml.quantity_delta) <> 0
     ORDER BY iml.item_id ASC, iml.uom ASC`,
    [locationId, tenantId]
  );
  const canonicalMapped = canonicalRows.map((row) => ({
    itemId: row.item_id,
    uom: row.uom,
    onHand: row.on_hand,
    isLegacy: false
  }));
  const legacyMapped = legacyRows
    .filter((row) => !canonicalItems.has(row.item_id))
    .map((row) => ({
      itemId: row.item_id,
      uom: row.uom,
      onHand: row.on_hand,
      isLegacy: true
    }));
  return [...canonicalMapped, ...legacyMapped];
}
