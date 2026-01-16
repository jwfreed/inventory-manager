import { query } from '../db';

export function mapMovement(row: any) {
  return {
    id: row.id,
    movementType: row.movement_type,
    status: row.status,
    externalRef: row.external_ref,
    occurredAt: row.occurred_at,
    postedAt: row.posted_at,
    notes: row.notes,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapMovementLine(row: any) {
  return {
    id: row.id,
    movementId: row.movement_id,
    itemId: row.item_id,
    locationId: row.location_id,
    quantityDelta: Number(row.quantity_delta),
    uom: row.uom,
    reasonCode: row.reason_code,
    lineNotes: row.line_notes,
    createdAt: row.created_at
  };
}

export async function getMovementWindow(
  tenantId: string,
  filters: { itemId?: string; locationId?: string }
): Promise<{ occurredFrom: string; occurredTo: string } | null> {
  const conditions: string[] = ["im.tenant_id = $1", "im.status = 'posted'"];
  const params: any[] = [tenantId];

  if (filters.itemId) {
    params.push(filters.itemId);
    conditions.push(`iml.item_id = $${params.length}`);
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`iml.location_id = $${params.length}`);
  }

  const { rows } = await query(
    `SELECT MIN(im.occurred_at) AS occurred_from,
            MAX(im.occurred_at) AS occurred_to
       FROM inventory_movement_lines iml
       JOIN inventory_movements im
         ON im.id = iml.movement_id
        AND im.tenant_id = iml.tenant_id
      WHERE ${conditions.join(' AND ')}`,
    params
  );

  const row = rows[0];
  if (!row?.occurred_from || !row?.occurred_to) {
    return null;
  }

  return {
    occurredFrom: row.occurred_from,
    occurredTo: row.occurred_to
  };
}

export async function listMovements(tenantId: string, filters: {
  movementType?: string;
  status?: string;
  externalRef?: string;
  occurredFrom?: string;
  occurredTo?: string;
  itemId?: string;
  locationId?: string;
  limit: number;
  offset: number;
}) {
  const conditions: string[] = ['tenant_id = $1'];
  const params: any[] = [tenantId];

  if (filters.movementType) {
    params.push(filters.movementType);
    conditions.push(`movement_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.externalRef) {
    params.push(`%${filters.externalRef}%`);
    conditions.push(`external_ref ILIKE $${params.length}`);
  }
  if (filters.occurredFrom) {
    params.push(filters.occurredFrom);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filters.occurredTo) {
    params.push(filters.occurredTo);
    conditions.push(`occurred_at <= $${params.length}`);
  }
  if (filters.itemId) {
    params.push(filters.itemId);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM inventory_movement_lines iml
         WHERE iml.movement_id = inventory_movements.id
           AND iml.tenant_id = inventory_movements.tenant_id
           AND iml.item_id = $${params.length}
      )`
    );
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM inventory_movement_lines iml
         WHERE iml.movement_id = inventory_movements.id
           AND iml.tenant_id = inventory_movements.tenant_id
           AND iml.location_id = $${params.length}
      )`
    );
  }

  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
     FROM inventory_movements
     ${where}
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return rows.map(mapMovement);
}

export async function getMovement(tenantId: string, id: string) {
  const res = await query(
    `SELECT id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
     FROM inventory_movements WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (res.rowCount === 0) return null;
  return mapMovement(res.rows[0]);
}

export async function getMovementLines(tenantId: string, id: string) {
  const res = await query(
    `SELECT id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes, created_at
     FROM inventory_movement_lines WHERE movement_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
    [id, tenantId]
  );
  return res.rows.map(mapMovementLine);
}
