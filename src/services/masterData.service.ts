import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type { itemSchema, locationSchema } from '../schemas/masterData.schema';

export type ItemInput = z.infer<typeof itemSchema>;
export type LocationInput = z.infer<typeof locationSchema>;

const itemSelectColumns = `
  i.id,
  i.sku,
  i.name,
  i.description,
  i.type,
  i.default_uom,
  i.default_location_id,
  i.active,
  i.created_at,
  i.updated_at,
  l.code AS default_location_code,
  l.name AS default_location_name
`;

export function mapItem(row: any) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    type: row.type ?? 'raw',
    defaultUom: row.defaultUom ?? row.default_uom ?? null,
    defaultLocationId: row.defaultLocationId ?? row.default_location_id ?? null,
    defaultLocationCode: row.defaultLocationCode ?? row.default_location_code ?? null,
    defaultLocationName: row.defaultLocationName ?? row.default_location_name ?? null,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createItem(data: ItemInput) {
  const now = new Date();
  const id = uuidv4();
  const active = data.active ?? true;
  const type = data.type ?? 'raw';
  const defaultUom = data.defaultUom ?? null;
  const defaultLocationId = data.defaultLocationId ?? null;
  await query(
    `INSERT INTO items (id, sku, name, description, type, default_uom, default_location_id, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [id, data.sku, data.name, data.description ?? null, type, defaultUom, defaultLocationId, active, now]
  );
  const created = await getItem(id);
  if (!created) throw new Error('Failed to create item.');
  return created;
}

export async function getItem(id: string) {
  const res = await query(
    `
    SELECT ${itemSelectColumns}
    FROM items i
    LEFT JOIN locations l ON l.id = i.default_location_id
    WHERE i.id = $1
  `,
    [id]
  );
  if (res.rowCount === 0) return null;
  return mapItem(res.rows[0]);
}

export async function updateItem(id: string, data: ItemInput) {
  const now = new Date();
  const type = data.type ?? 'raw';
  const defaultUom = data.defaultUom ?? null;
  const defaultLocationId = data.defaultLocationId ?? null;
  const res = await query(
    `UPDATE items
       SET sku = $1,
           name = $2,
           description = $3,
           type = $4,
           default_uom = $5,
           default_location_id = $6,
           active = $7,
           updated_at = $8
     WHERE id = $9
     RETURNING id`,
    [
      data.sku,
      data.name,
      data.description ?? null,
      type,
      defaultUom,
      defaultLocationId,
      data.active ?? true,
      now,
      id
    ]
  );
  if (res.rowCount === 0) return null;
  const updated = await getItem(id);
  if (!updated) throw new Error('Failed to load item after update.');
  return updated;
}

export async function listItems(filters: { active?: boolean; search?: string; limit: number; offset: number }) {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters.active !== undefined) {
    params.push(filters.active);
    conditions.push(`i.active = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(i.sku ILIKE $${idx} OR i.name ILIKE $${idx})`);
  }
  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT ${itemSelectColumns}
     FROM items i
     LEFT JOIN locations l ON l.id = i.default_location_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapItem);
}

export function mapLocation(row: any) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    active: row.active,
    parentLocationId: row.parent_location_id,
    path: row.path,
    depth: row.depth,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createLocation(data: LocationInput) {
  const now = new Date();
  const id = uuidv4();
  const active = data.active ?? true;

  return withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO locations (id, code, name, type, active, parent_location_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [id, data.code, data.name, data.type, active, data.parentLocationId ?? null, now]
    );
    return mapLocation(res.rows[0]);
  });
}

export async function getLocation(id: string) {
  const res = await query('SELECT * FROM locations WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapLocation(res.rows[0]);
}

export async function updateLocation(id: string, data: LocationInput) {
  const now = new Date();
  const active = data.active ?? true;
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE locations
         SET code = $1,
             name = $2,
             type = $3,
             active = $4,
             parent_location_id = $5,
             updated_at = $6
       WHERE id = $7
       RETURNING *`,
      [data.code, data.name, data.type, active, data.parentLocationId ?? null, now, id]
    );
    if (res.rowCount === 0) return null;
    return mapLocation(res.rows[0]);
  });
}

export async function listLocations(filters: {
  active?: boolean;
  type?: string;
  search?: string;
  limit: number;
  offset: number;
}) {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters.active !== undefined) {
    params.push(filters.active);
    conditions.push(`active = $${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    conditions.push(`type = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx})`);
  }
  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM locations
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapLocation);
}
