import type { PoolClient } from 'pg';
import { getWarehouseDefaultLocationId } from './warehouseDefaults.service';

export async function getQaLocation(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<string | null> {
  if (!warehouseId) throw new Error('WAREHOUSE_ID_REQUIRED');
  return getWarehouseDefaultLocationId(tenantId, warehouseId, 'QA', client);
}

export async function getHoldLocation(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<string | null> {
  if (!warehouseId) throw new Error('WAREHOUSE_ID_REQUIRED');
  return getWarehouseDefaultLocationId(tenantId, warehouseId, 'HOLD', client);
}

export async function getRejectLocation(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<string | null> {
  if (!warehouseId) throw new Error('WAREHOUSE_ID_REQUIRED');
  return getWarehouseDefaultLocationId(tenantId, warehouseId, 'REJECT', client);
}

export async function getDefaultSellableLocation(
  tenantId: string,
  warehouseId: string,
  client?: PoolClient
): Promise<string | null> {
  if (!warehouseId) throw new Error('WAREHOUSE_ID_REQUIRED');
  return getWarehouseDefaultLocationId(tenantId, warehouseId, 'SELLABLE', client);
}

// Legacy compatibility exports (do not use without explicit warehouse_id)
export const findQaLocation = getQaLocation;
export const findHoldLocation = getHoldLocation;
