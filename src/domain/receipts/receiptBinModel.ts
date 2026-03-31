import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';

export type InventoryBinRecord = {
  id: string;
  warehouseId: string;
  locationId: string;
  code: string;
  name: string;
  isDefault: boolean;
};

export async function resolveInventoryBin(params: {
  client: PoolClient;
  tenantId: string;
  warehouseId: string;
  locationId: string;
  binId?: string | null;
}) {
  if (params.binId) {
    const result = await params.client.query(
      `SELECT id, warehouse_id, location_id, code, name, is_default
         FROM inventory_bins
        WHERE id = $1
          AND tenant_id = $2
        LIMIT 1`,
      [params.binId, params.tenantId]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error('RECEIPT_BIN_NOT_FOUND');
    }
    const row = result.rows[0];
    if (row.location_id !== params.locationId || row.warehouse_id !== params.warehouseId) {
      throw new Error('RECEIPT_BIN_LOCATION_MISMATCH');
    }
    return {
      id: row.id,
      warehouseId: row.warehouse_id,
      locationId: row.location_id,
      code: row.code,
      name: row.name,
      isDefault: row.is_default
    } satisfies InventoryBinRecord;
  }

  const existing = await params.client.query(
    `SELECT id, warehouse_id, location_id, code, name, is_default
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
        AND is_default = true
      LIMIT 1`,
    [params.tenantId, params.locationId]
  );
  if ((existing.rowCount ?? 0) === 1) {
    const row = existing.rows[0];
    return {
      id: row.id,
      warehouseId: row.warehouse_id,
      locationId: row.location_id,
      code: row.code,
      name: row.name,
      isDefault: row.is_default
    } satisfies InventoryBinRecord;
  }

  const inserted = await params.client.query(
    `INSERT INTO inventory_bins (
        id, tenant_id, warehouse_id, location_id, code, name, is_default, active, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,true,true,now(),now())
     RETURNING id, warehouse_id, location_id, code, name, is_default`,
    [
      uuidv4(),
      params.tenantId,
      params.warehouseId,
      params.locationId,
      'DEFAULT',
      'Default Bin'
    ]
  );
  const row = inserted.rows[0] ?? (
    await params.client.query(
      `SELECT id, warehouse_id, location_id, code, name, is_default
         FROM inventory_bins
        WHERE tenant_id = $1
          AND location_id = $2
          AND is_default = true
        LIMIT 1`,
      [params.tenantId, params.locationId]
    )
  ).rows[0];
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    locationId: row.location_id,
    code: row.code,
    name: row.name,
    isDefault: row.is_default
  } satisfies InventoryBinRecord;
}

export function assertBinTraceability(params: {
  warehouseId: string;
  locationId: string;
  binId: string | null | undefined;
}) {
  if (!params.warehouseId || !params.locationId || !params.binId) {
    throw new Error('RECEIPT_BIN_TRACEABILITY_VIOLATION');
  }
}
