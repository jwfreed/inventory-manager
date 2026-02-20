import { atpCache } from '../lib/cache';

type AtpCacheParams = {
  itemId?: string;
  locationId?: string;
  limit?: number;
  offset?: number;
};

function buildSortedParams(params: AtpCacheParams) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function buildAtpCacheKey(tenantId: string, warehouseId: string, params: AtpCacheParams = {}): string {
  if (!warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }
  const base = `atp:${tenantId}:scope=sellable&warehouseId=${warehouseId}`;
  const suffix = buildSortedParams(params);
  return suffix ? `${base}&${suffix}` : base;
}

export function getAtpCacheValue<T>(
  tenantId: string,
  warehouseId: string,
  params: AtpCacheParams = {}
): T | undefined {
  return atpCache.get(buildAtpCacheKey(tenantId, warehouseId, params)) as T | undefined;
}

export function setAtpCacheValue<T>(
  tenantId: string,
  warehouseId: string,
  params: AtpCacheParams,
  value: T
): void {
  atpCache.set(buildAtpCacheKey(tenantId, warehouseId, params), value);
}

export function invalidateAtpCacheForWarehouse(tenantId: string, warehouseId: string): void {
  atpCache.invalidate(`atp:${tenantId}:scope=sellable&warehouseId=${warehouseId}`);
}
