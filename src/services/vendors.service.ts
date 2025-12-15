import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import type { vendorSchema } from '../schemas/vendors.schema';

export type VendorInput = z.infer<typeof vendorSchema>;

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
