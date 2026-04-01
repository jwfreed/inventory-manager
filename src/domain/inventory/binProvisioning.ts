import { query } from '../../db';
import { v5 as uuidv5 } from 'uuid';

const DEFAULT_BIN_NAMESPACE = 'ff6e4f7d-5c46-4f35-9f0d-8fcfefb44311';

export type InventoryBinProvisioningTx = {
  query: (...args: any[]) => Promise<any>;
};

type LocationInventoryCapabilityRow = {
  warehouse_id: string | null;
  parent_location_id: string | null;
  code: string | null;
  name: string | null;
  type: string;
  role: string | null;
  is_sellable: boolean;
};

type InventoryBinRow = {
  id: string;
  is_default: boolean;
};

function resolveExecutor(tx?: InventoryBinProvisioningTx) {
  return tx?.query.bind(tx) ?? query;
}

function isInventoryCapableLocation(location: LocationInventoryCapabilityRow): boolean {
  return (
    location.type !== 'warehouse'
    && location.role !== null
    && location.parent_location_id !== null
    && location.warehouse_id !== null
  );
}

function deterministicDefaultBinId(tenantId: string, locationId: string): string {
  return uuidv5(`${tenantId}:${locationId}:DEFAULT`, DEFAULT_BIN_NAMESPACE);
}

function buildDefaultBinCode(location: Pick<LocationInventoryCapabilityRow, 'code'>): string {
  return typeof location.code === 'string' && location.code.trim().length > 0
    ? `${location.code.trim()}-DEFAULT`
    : 'DEFAULT';
}

function buildDefaultBinName(location: Pick<LocationInventoryCapabilityRow, 'name'>): string {
  return typeof location.name === 'string' && location.name.trim().length > 0
    ? `${location.name.trim()} Default Bin`
    : 'Default Bin';
}

function selectCanonicalDefaultBinId(rows: InventoryBinRow[], expectedDefaultBinId: string): string | null {
  if (rows.length === 0) return null;
  const deterministic = rows.find((row) => row.id === expectedDefaultBinId);
  if (deterministic) return deterministic.id;
  const existingDefault = rows.find((row) => row.is_default === true);
  if (existingDefault) return existingDefault.id;
  return rows[0]?.id ?? null;
}

export async function ensureLocationInventoryReady(
  locationId: string,
  tenantId: string,
  tx?: InventoryBinProvisioningTx
): Promise<{ created: boolean; normalized: boolean; binId: string; defaultBinId: string }> {
  const executor = resolveExecutor(tx);
  const locationRes = await executor<LocationInventoryCapabilityRow>(
    `SELECT warehouse_id, parent_location_id, code, name, type, role, is_sellable
       FROM locations
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, locationId]
  );
  if ((locationRes.rowCount ?? 0) !== 1) {
    throw new Error('LOCATION_BIN_PROVISIONING_LOCATION_NOT_FOUND');
  }

  const location = locationRes.rows[0];
  if (!isInventoryCapableLocation(location)) {
    throw new Error('LOCATION_BIN_PROVISIONING_LOCATION_NOT_INVENTORY_CAPABLE');
  }

  const defaultBinId = deterministicDefaultBinId(tenantId, locationId);
  const code = buildDefaultBinCode(location);
  const name = buildDefaultBinName(location);

  const existingRes = await executor<InventoryBinRow>(
    `SELECT id, is_default
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
      ORDER BY CASE WHEN id = $3 THEN 0 ELSE 1 END, is_default DESC, created_at ASC, id ASC`,
    [tenantId, locationId, defaultBinId]
  );

  let created = false;
  if ((existingRes.rowCount ?? 0) === 0) {
    await executor(
      `INSERT INTO inventory_bins (
          id,
          tenant_id,
          warehouse_id,
          location_id,
          code,
          name,
          is_default,
          active,
          created_at,
          updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, true, true, now(), now())
       ON CONFLICT DO NOTHING`,
      [defaultBinId, tenantId, location.warehouse_id, locationId, code, name]
    );
    created = true;
  }

  const ensuredRes = await executor<InventoryBinRow>(
    `SELECT id, is_default
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2
      ORDER BY CASE WHEN id = $3 THEN 0 ELSE 1 END, is_default DESC, created_at ASC, id ASC`,
    [tenantId, locationId, defaultBinId]
  );
  const rows = ensuredRes.rows as InventoryBinRow[];
  const canonicalDefaultBinId = selectCanonicalDefaultBinId(rows, defaultBinId);
  if (!canonicalDefaultBinId) {
    throw new Error('LOCATION_BIN_PROVISIONING_FAILED');
  }

  const defaultCount = rows.filter((row) => row.is_default === true).length;
  let normalized = false;
  if (defaultCount !== 1 || rows[0]?.id !== canonicalDefaultBinId || rows[0]?.is_default !== true) {
    const normalizeRes = await executor(
      `UPDATE inventory_bins
          SET is_default = CASE WHEN id = $3 THEN true ELSE false END,
              updated_at = now()
        WHERE tenant_id = $1
          AND location_id = $2
          AND is_default IS DISTINCT FROM CASE WHEN id = $3 THEN true ELSE false END`,
      [tenantId, locationId, canonicalDefaultBinId]
    );
    normalized = (normalizeRes.rowCount ?? 0) > 0;
  }

  return {
    created,
    normalized,
    binId: rows[0]?.id ?? canonicalDefaultBinId,
    defaultBinId: canonicalDefaultBinId
  };
}

export async function assertLocationInventoryReady(
  locationId: string,
  tenantId: string,
  tx?: InventoryBinProvisioningTx
): Promise<{ binId: string; defaultBinId: string }> {
  const executor = resolveExecutor(tx);
  const readyRes = await executor<{ bin_count: string; default_count: string; default_bin_id: string | null }>(
    `SELECT COUNT(*)::text AS bin_count,
            COUNT(*) FILTER (WHERE is_default = true)::text AS default_count,
            MIN(id) FILTER (WHERE is_default = true)::text AS default_bin_id
       FROM inventory_bins
      WHERE tenant_id = $1
        AND location_id = $2`,
    [tenantId, locationId]
  );
  const row = readyRes.rows[0];
  const binCount = Number(row?.bin_count ?? 0);
  const defaultCount = Number(row?.default_count ?? 0);

  if (binCount < 1 || defaultCount !== 1 || !row?.default_bin_id) {
    throw new Error('LOCATION_INVENTORY_NOT_READY');
  }

  return {
    binId: row.default_bin_id,
    defaultBinId: row.default_bin_id
  };
}

export const ensureLocationHasAtLeastOneBin = ensureLocationInventoryReady;
