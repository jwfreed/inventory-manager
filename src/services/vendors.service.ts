import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import type { vendorSchema, vendorUpdateSchema } from '../schemas/vendors.schema';

export type VendorInput = z.infer<typeof vendorSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;

export async function createVendor(tenantId: string, data: VendorInput) {
  const now = new Date();
  const id = uuidv4();
  const { rows } = await query(
    `INSERT INTO vendors (id, tenant_id, code, name, email, phone, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)
     RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, tenantId, data.code, data.name, data.email ?? null, data.phone ?? null, now]
  );
  return rows[0];
}

export async function listVendors(tenantId: string) {
  const { rows } = await query(
    `SELECT id, code, name, email, phone, active, created_at, updated_at
     FROM vendors
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

export async function listVendorsFiltered(tenantId: string, active?: boolean) {
  const params: any[] = [tenantId];
  let where = 'WHERE tenant_id = $1';
  if (active !== undefined) {
    where = `${where} AND active = $2`;
    params.push(active);
  }
  const { rows } = await query(
    `SELECT id, code, name, email, phone, active, created_at, updated_at
     FROM vendors
     ${where}
     ORDER BY created_at DESC`,
    params
  );
  return rows;
}

export async function updateVendor(tenantId: string, id: string, data: VendorUpdateInput) {
  const now = new Date();
  const { rows } = await query(
    `UPDATE vendors
        SET code = $2,
            name = $3,
            email = $4,
            phone = $5,
            active = COALESCE($6, active),
            updated_at = $7
      WHERE id = $1 AND tenant_id = $8
      RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, data.code, data.name, data.email ?? null, data.phone ?? null, data.active ?? null, now, tenantId]
  );
  return rows[0] ?? null;
}

export async function deactivateVendor(tenantId: string, id: string) {
  const now = new Date();
  const { rows } = await query(
    `UPDATE vendors
        SET active = false,
            updated_at = $2
      WHERE id = $1 AND tenant_id = $3
      RETURNING id, code, name, email, phone, active, created_at, updated_at`,
    [id, now, tenantId]
  );
  return rows[0] ?? null;
}
