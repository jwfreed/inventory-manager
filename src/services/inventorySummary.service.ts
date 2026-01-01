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
  const { rows } = await query(
    `SELECT iml.location_id, iml.uom, SUM(iml.quantity_delta) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.item_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
     GROUP BY iml.location_id, iml.uom
     HAVING SUM(iml.quantity_delta) <> 0
     ORDER BY iml.location_id ASC, iml.uom ASC`,
    [itemId, tenantId]
  );
  return rows.map((row) => ({
    locationId: row.location_id,
    uom: row.uom,
    onHand: row.on_hand
  }));
}

export async function getLocationInventorySummary(tenantId: string, locationId: string) {
  const { rows } = await query(
    `SELECT iml.item_id, iml.uom, SUM(iml.quantity_delta) AS on_hand
     FROM inventory_movement_lines iml
     JOIN inventory_movements im ON im.id = iml.movement_id
     WHERE im.status = 'posted' AND iml.location_id = $1
       AND iml.tenant_id = $2
       AND im.tenant_id = $2
     GROUP BY iml.item_id, iml.uom
     HAVING SUM(iml.quantity_delta) <> 0
     ORDER BY iml.item_id ASC, iml.uom ASC`,
    [locationId, tenantId]
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    uom: row.uom,
    onHand: row.on_hand
  }));
}
