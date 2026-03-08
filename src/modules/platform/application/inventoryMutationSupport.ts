import type { PoolClient } from 'pg';
import { applyInventoryBalanceDelta } from '../../../domains/inventory';
import { refreshItemCostSummaryProjection } from '../../costing/infrastructure/itemCostSummary.projector';
import type { InventoryCommandEvent, InventoryCommandProjectionOp } from './runInventoryCommand';

export function buildMovementPostedEvent(
  movementId: string,
  producerIdempotencyKey?: string | null
): InventoryCommandEvent {
  return {
    aggregateType: 'inventory_movement',
    aggregateId: movementId,
    eventType: 'inventory.movement.posted',
    eventVersion: 1,
    producerIdempotencyKey: producerIdempotencyKey ?? null,
    payload: { movementId }
  };
}

export async function inventoryEventVersionExists(
  client: PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventVersion: number
) {
  const res = await client.query(
    `SELECT 1
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = $2
        AND aggregate_id = $3
        AND event_version = $4
      LIMIT 1`,
    [tenantId, aggregateType, aggregateId, eventVersion]
  );
  return res.rowCount > 0;
}

export async function authoritativeMovementExists(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const res = await client.query(
    `SELECT 1
       FROM inventory_movements
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  return res.rowCount > 0;
}

export async function authoritativeMovementReady(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const res = await client.query(
    `SELECT EXISTS (
         SELECT 1
           FROM inventory_movements m
          WHERE m.tenant_id = $1
            AND m.id = $2
       ) AS movement_exists,
       EXISTS (
         SELECT 1
           FROM inventory_movement_lines ml
          WHERE ml.tenant_id = $1
            AND ml.movement_id = $2
       ) AS has_lines`,
    [tenantId, movementId]
  );
  const row = res.rows[0] ?? {};
  return {
    movementExists: !!row.movement_exists,
    hasLines: !!row.has_lines,
    ready: !!row.movement_exists && !!row.has_lines
  };
}

export function buildInventoryBalanceProjectionOp(params: {
  tenantId: string;
  itemId: string;
  locationId: string;
  uom: string;
  deltaOnHand?: number;
  deltaReserved?: number;
  deltaAllocated?: number;
}): InventoryCommandProjectionOp {
  return async (client: PoolClient) => {
    await applyInventoryBalanceDelta(client, params);
  };
}

export function buildRefreshItemCostSummaryProjectionOp(
  tenantId: string,
  itemId: string
): InventoryCommandProjectionOp {
  return async (client: PoolClient) => {
    await refreshItemCostSummaryProjection(tenantId, itemId, client);
  };
}
