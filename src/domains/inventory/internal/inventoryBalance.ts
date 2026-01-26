import type { PoolClient } from 'pg';
import { pool } from '../../../db';
import { roundQuantity, toNumber } from '../../../lib/numbers';

const EPSILON = 1e-6;

export type InventoryBalanceRow = {
  tenant_id: string;
  item_id: string;
  location_id: string;
  uom: string;
  on_hand: string | number;
  reserved: string | number;
  created_at: string;
  updated_at: string;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

export async function ensureInventoryBalanceRow(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  await client.query(
    `INSERT INTO inventory_balance (
        tenant_id, item_id, location_id, uom, on_hand, reserved, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 0, 0, now(), now())
     ON CONFLICT (tenant_id, item_id, location_id, uom) DO NOTHING`,
    [tenantId, itemId, locationId, uom]
  );
}

export async function getInventoryBalanceForUpdate(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  await ensureInventoryBalanceRow(client, tenantId, itemId, locationId, uom);
  const res = await client.query<InventoryBalanceRow>(
    `SELECT * FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4
      FOR UPDATE`,
    [tenantId, itemId, locationId, uom]
  );
  if (res.rowCount === 0) {
    throw new Error('INVENTORY_BALANCE_ROW_MISSING');
  }
  const row = res.rows[0];
  return {
    onHand: normalizeQuantity(row.on_hand),
    reserved: normalizeQuantity(row.reserved)
  };
}

export async function applyInventoryBalanceDelta(
  client: PoolClient,
  params: {
    tenantId: string;
    itemId: string;
    locationId: string;
    uom: string;
    deltaOnHand?: number;
    deltaReserved?: number;
  }
) {
  const deltaOnHand = params.deltaOnHand ?? 0;
  const deltaReserved = params.deltaReserved ?? 0;
  if (Math.abs(deltaOnHand) <= EPSILON && Math.abs(deltaReserved) <= EPSILON) {
    return;
  }
  const current = await getInventoryBalanceForUpdate(
    client,
    params.tenantId,
    params.itemId,
    params.locationId,
    params.uom
  );
  const nextOnHand = roundQuantity(current.onHand + deltaOnHand);
  const nextReserved = roundQuantity(current.reserved + deltaReserved);
  if (nextReserved < -EPSILON) {
    throw new Error('INVENTORY_BALANCE_RESERVED_NEGATIVE');
  }
  await client.query(
    `UPDATE inventory_balance
        SET on_hand = $1,
            reserved = $2,
            updated_at = now()
      WHERE tenant_id = $3 AND item_id = $4 AND location_id = $5 AND uom = $6`,
    [nextOnHand, Math.max(0, nextReserved), params.tenantId, params.itemId, params.locationId, params.uom]
  );
}

export async function getInventoryBalance(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await executor<InventoryBalanceRow>(
    `SELECT * FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const onHand = normalizeQuantity(row.on_hand);
  const reserved = normalizeQuantity(row.reserved);
  return {
    onHand,
    reserved,
    available: roundQuantity(onHand - reserved)
  };
}
