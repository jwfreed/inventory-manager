import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import type { vendorSchema, vendorUpdateSchema } from '../schemas/vendors.schema';

export type VendorInput = z.infer<typeof vendorSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;

export async function createVendor(data: VendorInput) {
  const now = new Date();
  const id = uuidv4();
  const { rows } = await query(
    `INSERT INTO vendors (id, code, name, email, phone, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $6)
     RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, data.code, data.name, data.email ?? null, data.phone ?? null, now]
  );
  return rows[0];
}

export async function listVendors() {
  const { rows } = await query(
    'SELECT id, code, name, email, phone, active, created_at, updated_at FROM vendors ORDER BY created_at DESC'
  );
  return rows;
}

export async function listVendorsFiltered(active?: boolean) {
  const params: any[] = [];
  let where = '';
  if (active !== undefined) {
    where = 'WHERE active = $1';
    params.push(active);
  }
  const { rows } = await query(
    `SELECT id, code, name, email, phone, active, created_at, updated_at FROM vendors ${where} ORDER BY created_at DESC`,
    params
  );
  return rows;
}

export async function updateVendor(id: string, data: VendorUpdateInput) {
  const now = new Date();
  const { rows } = await query(
    `UPDATE vendors
        SET code = $2,
            name = $3,
            email = $4,
            phone = $5,
            active = COALESCE($6, active),
            updated_at = $7
      WHERE id = $1
      RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, data.code, data.name, data.email ?? null, data.phone ?? null, data.active ?? null, now]
  );
  return rows[0] ?? null;
}

export async function deactivateVendor(id: string) {
  const now = new Date();
  const { rows } = await query(
    `UPDATE vendors
        SET active = false,
            updated_at = $2
      WHERE id = $1
      RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, now]
  );
  return rows[0] ?? null;
}
