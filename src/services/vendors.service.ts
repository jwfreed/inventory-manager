import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import type { vendorSchema, vendorUpdateSchema } from '../schemas/vendors.schema';

export type VendorInput = z.infer<typeof vendorSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;

const vendorSelectColumns = `
  id,
  code,
  name,
  email,
  phone,
  contact_name AS "contactName",
  address_line1 AS "addressLine1",
  address_line2 AS "addressLine2",
  city,
  state,
  postal_code AS "postalCode",
  country,
  notes,
  active,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function createVendor(tenantId: string, data: VendorInput) {
  const now = new Date();
  const id = uuidv4();
  const { rows } = await query(
    `INSERT INTO vendors (
        id, tenant_id, code, name, email, phone, contact_name, address_line1, address_line2,
        city, state, postal_code, country, notes, active, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15, $15)
     RETURNING ${vendorSelectColumns}`,
    [
      id,
      tenantId,
      data.code,
      data.name,
      data.email ?? null,
      data.phone ?? null,
      data.contactName ?? null,
      data.addressLine1 ?? null,
      data.addressLine2 ?? null,
      data.city ?? null,
      data.state ?? null,
      data.postalCode ?? null,
      data.country ?? null,
      data.notes ?? null,
      now,
    ]
  );
  return rows[0];
}

export async function listVendors(tenantId: string) {
  const { rows } = await query(
    `SELECT ${vendorSelectColumns}
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
    `SELECT ${vendorSelectColumns}
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
            contact_name = $6,
            address_line1 = $7,
            address_line2 = $8,
            city = $9,
            state = $10,
            postal_code = $11,
            country = $12,
            notes = $13,
            active = COALESCE($14, active),
            updated_at = $15
      WHERE id = $1 AND tenant_id = $16
      RETURNING ${vendorSelectColumns}`,
    [
      id,
      data.code,
      data.name,
      data.email ?? null,
      data.phone ?? null,
      data.contactName ?? null,
      data.addressLine1 ?? null,
      data.addressLine2 ?? null,
      data.city ?? null,
      data.state ?? null,
      data.postalCode ?? null,
      data.country ?? null,
      data.notes ?? null,
      data.active ?? null,
      now,
      tenantId,
    ]
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
      RETURNING ${vendorSelectColumns}`,
    [id, now, tenantId]
  );
  return rows[0] ?? null;
}
