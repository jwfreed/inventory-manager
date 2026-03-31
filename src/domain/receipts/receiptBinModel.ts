import type { PoolClient } from 'pg';

export type InventoryBinRecord = {
  id: string;
  warehouseId: string;
  locationId: string;
  code: string;
  name: string;
  isDefault: boolean;
};

export function assertInventoryBinResolutionPolicy(params: {
  binId?: string | null;
  allowDefaultBinResolution?: boolean;
}) {
  if (params.binId) {
    return 'explicit' as const;
  }
  if (!params.allowDefaultBinResolution) {
    throw new Error('RECEIPT_BIN_REQUIRED');
  }
  return 'default_existing' as const;
}

export async function resolveInventoryBin(params: {
  client: PoolClient;
  tenantId: string;
  warehouseId: string;
  locationId: string;
  binId?: string | null;
  allowDefaultBinResolution?: boolean;
}) {
  const resolutionMode = assertInventoryBinResolutionPolicy({
    binId: params.binId,
    allowDefaultBinResolution: params.allowDefaultBinResolution
  });

  if (resolutionMode === 'explicit') {
    const result = await params.client.query(
      `SELECT ib.id, ib.warehouse_id, ib.location_id, ib.code, ib.name, ib.is_default
         FROM inventory_bins ib
         JOIN locations w
           ON w.id = ib.warehouse_id
          AND w.tenant_id = ib.tenant_id
          AND w.type = 'warehouse'
        WHERE ib.id = $1
          AND ib.tenant_id = $2
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
    `SELECT ib.id, ib.warehouse_id, ib.location_id, ib.code, ib.name, ib.is_default
       FROM inventory_bins ib
       JOIN locations w
         ON w.id = ib.warehouse_id
        AND w.tenant_id = ib.tenant_id
        AND w.type = 'warehouse'
      WHERE ib.tenant_id = $1
        AND ib.location_id = $2
        AND ib.is_default = true
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
  throw new Error('RECEIPT_DEFAULT_BIN_REQUIRED');
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
