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
