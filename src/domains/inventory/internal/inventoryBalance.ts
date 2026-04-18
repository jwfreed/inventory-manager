import type { PoolClient } from 'pg';
import {
  applyInventoryBalanceProjectionDelta,
  ensureInventoryBalanceProjectionRow,
  ensureInventoryBalanceProjectionRowAndLock,
  getInventoryBalanceProjection,
  type InventoryBalanceProjectionRow
} from '../../../modules/availability/infrastructure/inventoryBalance.projector';

export type InventoryBalanceRow = InventoryBalanceProjectionRow;

export async function ensureInventoryBalanceRow(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  return ensureInventoryBalanceProjectionRow(client, tenantId, itemId, locationId, uom);
}

export async function getInventoryBalanceForUpdate(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  return ensureInventoryBalanceRowAndLock(client, tenantId, itemId, locationId, uom);
}

export async function ensureInventoryBalanceRowAndLock(
  client: PoolClient,
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string
) {
  return ensureInventoryBalanceProjectionRowAndLock(client, tenantId, itemId, locationId, uom);
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
    deltaAllocated?: number;
    mutationContext?: {
      movementId?: string | null;
      sourceLineId?: string | null;
      reasonCode?: string | null;
      eventTimestamp?: Date | string | null;
      stateTransition?: string | null;
    };
  }
) {
  return applyInventoryBalanceProjectionDelta(client, params);
}

export async function getInventoryBalance(
  tenantId: string,
  itemId: string,
  locationId: string,
  uom: string,
  client?: PoolClient
) {
  return getInventoryBalanceProjection(tenantId, itemId, locationId, uom, client);
}
