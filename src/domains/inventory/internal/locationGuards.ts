import type { PoolClient } from 'pg';

type SellableLocationRow = {
  id: string;
  warehouse_id: string;
  is_sellable: boolean;
};

type SellableGuardOptions = {
  expectedWarehouseId?: string | null;
  nonSellableCode?: string;
  warehouseMismatchCode?: string;
  locationNotFoundCode?: string;
};

export async function assertSellableLocationOrThrow(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  options: SellableGuardOptions = {}
): Promise<{ locationId: string; warehouseId: string }> {
  const nonSellableCode = options.nonSellableCode ?? 'NON_SELLABLE_LOCATION';
  const warehouseMismatchCode = options.warehouseMismatchCode ?? 'WAREHOUSE_SCOPE_MISMATCH';
  const locationNotFoundCode = options.locationNotFoundCode ?? 'LOCATION_NOT_FOUND';

  const res = await client.query<SellableLocationRow>(
    `SELECT id, warehouse_id, is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, locationId]
  );

  if (res.rowCount === 0 || !res.rows[0]) {
    throw new Error(locationNotFoundCode);
  }

  const row = res.rows[0];
  if (!row.is_sellable) {
    throw new Error(nonSellableCode);
  }
  if (options.expectedWarehouseId && row.warehouse_id !== options.expectedWarehouseId) {
    throw new Error(warehouseMismatchCode);
  }

  return {
    locationId: row.id,
    warehouseId: row.warehouse_id
  };
}
