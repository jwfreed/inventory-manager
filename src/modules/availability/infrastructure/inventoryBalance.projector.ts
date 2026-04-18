import type { PoolClient } from 'pg';
import { pool } from '../../../db';
import { roundQuantity, toNumber } from '../../../lib/numbers';

const EPSILON = 1e-6;

// inventory_balance is a derived projection of authoritative inventory_ledger
// and reservation state. Commands may update it synchronously for compatibility,
// but it must never be treated as the physical inventory source of truth.
export type InventoryBalanceProjectionRow = {
  tenant_id: string;
  item_id: string;
  location_id: string;
  uom: string;
  on_hand: string | number;
  reserved: string | number;
  allocated: string | number;
  created_at: string;
  updated_at: string;
};

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

export async function ensureInventoryBalanceProjectionRow(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  const inserted = await client.query(
    `INSERT INTO inventory_balance (
        tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, 0, 0, 0, now(), now())
     ON CONFLICT (tenant_id, item_id, location_id, uom) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, itemId, locationId, uom]
  );

  // Backfill the new projection row from the authoritative ledger-derived view.
  if (inserted.rowCount === 0) return;

  const ledgerRes = await client.query<{ on_hand_qty: string | number }>(
    `SELECT on_hand_qty
       FROM inventory_on_hand_location_v
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4
      LIMIT 1`,
    [tenantId, itemId, locationId, uom]
  );
  const onHandQty = normalizeQuantity(ledgerRes.rows[0]?.on_hand_qty ?? 0);
  if (Math.abs(onHandQty) <= EPSILON) return;

  await client.query(
    `UPDATE inventory_balance
        SET on_hand = $5,
            updated_at = now()
      WHERE tenant_id = $1
        AND item_id = $2
        AND location_id = $3
        AND uom = $4`,
    [tenantId, itemId, locationId, uom, onHandQty]
  );
}

export async function ensureInventoryBalanceProjectionRowAndLock(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  await ensureInventoryBalanceProjectionRow(client, tenantId, itemId, locationId, uom);
  const res = await client.query<InventoryBalanceProjectionRow>(
    `SELECT * FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4
      FOR UPDATE`,
    [tenantId, itemId, locationId, uom]
  );
  if (res.rowCount === 0) {
    throw new Error('INVENTORY_BALANCE_ROW_MISSING');
  }
  const row = res.rows[0];
  const onHand = normalizeQuantity(row.on_hand);
  const reserved = normalizeQuantity(row.reserved);
  const allocated = normalizeQuantity(row.allocated);
  return {
    onHand,
    reserved,
    allocated,
    available: roundQuantity(onHand - reserved - allocated)
  };
}

export async function applyInventoryBalanceProjectionDelta(
  client: PoolClient,
  params: {
    tenantId: string;
    itemId: string;
    locationId: string;
    uom: string;
    deltaOnHand?: number;
    deltaReserved?: number;
    deltaAllocated?: number;
  }
) {
  const deltaOnHand = params.deltaOnHand ?? 0;
  const deltaReserved = params.deltaReserved ?? 0;
  const deltaAllocated = params.deltaAllocated ?? 0;
  if (
    Math.abs(deltaOnHand) <= EPSILON &&
    Math.abs(deltaReserved) <= EPSILON &&
    Math.abs(deltaAllocated) <= EPSILON
  ) {
    return;
  }

  let balanceRes = await client.query<InventoryBalanceProjectionRow>(
    `SELECT * FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4
      FOR UPDATE`,
    [params.tenantId, params.itemId, params.locationId, params.uom]
  );

  if (balanceRes.rowCount === 0) {
    await client.query(
      `INSERT INTO inventory_balance (
          tenant_id, item_id, location_id, uom, on_hand, reserved, allocated, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, 0, 0, 0, now(), now())
       ON CONFLICT (tenant_id, item_id, location_id, uom) DO NOTHING`,
      [params.tenantId, params.itemId, params.locationId, params.uom]
    );
    balanceRes = await client.query<InventoryBalanceProjectionRow>(
      `SELECT * FROM inventory_balance
        WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4
        FOR UPDATE`,
      [params.tenantId, params.itemId, params.locationId, params.uom]
    );
  }

  if (balanceRes.rowCount === 0) {
    throw new Error('INVENTORY_BALANCE_ROW_MISSING');
  }
  const currentRow = balanceRes.rows[0];
  const current = {
    onHand: normalizeQuantity(currentRow.on_hand),
    reserved: normalizeQuantity(currentRow.reserved),
    allocated: normalizeQuantity(currentRow.allocated)
  };
  const currentAvailable = roundQuantity(current.onHand - current.reserved - current.allocated);
  const allocationAvailable = roundQuantity(currentAvailable + Math.max(0, -deltaReserved));
  if (deltaAllocated > EPSILON && deltaAllocated - allocationAvailable > EPSILON) {
    console.error('INVENTORY_INVARIANT_VIOLATION', {
      invariant: 'allocation_lte_available',
      tenantId: params.tenantId,
      itemId: params.itemId,
      locationId: params.locationId,
      uom: params.uom,
      deltaAllocated,
      allocationAvailable
    });
    throw new Error('INVENTORY_BALANCE_ALLOCATION_EXCEEDS_AVAILABLE');
  }
  const nextOnHand = roundQuantity(current.onHand + deltaOnHand);
  const nextReserved = roundQuantity(current.reserved + deltaReserved);
  const nextAllocated = roundQuantity(current.allocated + deltaAllocated);
  const nextAvailable = roundQuantity(nextOnHand - nextReserved - nextAllocated);
  if (nextReserved < -EPSILON) {
    console.error('INVENTORY_INVARIANT_VIOLATION', {
      invariant: 'reserved_non_negative',
      tenantId: params.tenantId,
      itemId: params.itemId,
      locationId: params.locationId,
      uom: params.uom,
      nextReserved
    });
    throw new Error('INVENTORY_BALANCE_RESERVED_NEGATIVE');
  }
  if (nextAllocated < -EPSILON) {
    console.error('INVENTORY_INVARIANT_VIOLATION', {
      invariant: 'allocated_non_negative',
      tenantId: params.tenantId,
      itemId: params.itemId,
      locationId: params.locationId,
      uom: params.uom,
      nextAllocated
    });
    throw new Error('INVENTORY_BALANCE_ALLOCATED_NEGATIVE');
  }
  if (nextAvailable < -EPSILON) {
    console.error('INVENTORY_INVARIANT_VIOLATION', {
      invariant: 'available_non_negative',
      tenantId: params.tenantId,
      itemId: params.itemId,
      locationId: params.locationId,
      uom: params.uom,
      nextAvailable
    });
    throw new Error('INVENTORY_BALANCE_AVAILABLE_NEGATIVE');
  }
  if (nextAllocated - roundQuantity(nextOnHand - nextReserved) > EPSILON) {
    console.error('INVENTORY_INVARIANT_VIOLATION', {
      invariant: 'allocated_lte_available_base',
      tenantId: params.tenantId,
      itemId: params.itemId,
      locationId: params.locationId,
      uom: params.uom,
      nextAllocated,
      nextOnHand,
      nextReserved
    });
    throw new Error('INVENTORY_BALANCE_ALLOCATION_EXCEEDS_AVAILABLE');
  }
  await client.query(
    `UPDATE inventory_balance
        SET on_hand = $1,
            reserved = $2,
            allocated = $3,
            updated_at = now()
      WHERE tenant_id = $4 AND item_id = $5 AND location_id = $6 AND uom = $7`,
    [
      nextOnHand,
      Math.max(0, nextReserved),
      Math.max(0, nextAllocated),
      params.tenantId,
      params.itemId,
      params.locationId,
      params.uom
    ]
  );
}

export async function getInventoryBalanceProjection(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : pool.query.bind(pool);
  const res = await executor<InventoryBalanceProjectionRow>(
    `SELECT * FROM inventory_balance
      WHERE tenant_id = $1 AND item_id = $2 AND location_id = $3 AND uom = $4`,
    [tenantId, itemId, locationId, uom]
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const onHand = normalizeQuantity(row.on_hand);
  const reserved = normalizeQuantity(row.reserved);
  const allocated = normalizeQuantity(row.allocated);
  return {
    onHand,
    reserved,
    allocated,
    available: roundQuantity(onHand - reserved - allocated)
  };
}
