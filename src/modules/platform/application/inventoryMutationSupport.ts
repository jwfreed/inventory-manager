import type { PoolClient } from 'pg';
import { applyInventoryBalanceDelta } from '../../../domains/inventory';
import { refreshItemCostSummaryProjection } from '../../costing/infrastructure/itemCostSummary.projector';
import type { InventoryCommandEvent, InventoryCommandProjectionOp } from './runInventoryCommand';
import { buildInventoryRegistryEvent } from './inventoryEventRegistry';

export function buildMovementPostedEvent(
  movementId: string,
  producerIdempotencyKey?: string | null
): InventoryCommandEvent {
  return buildInventoryRegistryEvent('inventoryMovementPosted', {
    producerIdempotencyKey,
    payload: { movementId }
  });
}

export async function inventoryEventVersionExists(
  client: PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  eventVersion: number
) {
  const res = await client.query(
    `SELECT 1
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = $2
        AND aggregate_id = $3
        AND event_type = $4
        AND event_version = $5
      LIMIT 1`,
    [tenantId, aggregateType, aggregateId, eventType, eventVersion]
  );
  return (res.rowCount ?? 0) > 0;
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
  return (res.rowCount ?? 0) > 0;
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

export async function buildPostedDocumentReplayResult<T>(params: {
  tenantId: string;
  authoritativeMovementIds: string[];
  client: PoolClient;
  fetchAggregateView: () => Promise<T | null>;
  aggregateNotFoundError: Error;
  movementNotReadyError: (movementId: string, readiness: {
    movementExists: boolean;
    hasLines: boolean;
    ready: boolean;
  }) => Error;
  authoritativeEvents: InventoryCommandEvent[];
  responseStatus?: number;
}) {
  for (const movementId of params.authoritativeMovementIds) {
    const readiness = await authoritativeMovementReady(params.client, params.tenantId, movementId);
    if (!readiness.ready) {
      throw params.movementNotReadyError(movementId, readiness);
    }
  }

  const aggregateView = await params.fetchAggregateView();
  if (!aggregateView) {
    throw params.aggregateNotFoundError;
  }

  const events: InventoryCommandEvent[] = [];
  for (const event of params.authoritativeEvents) {
    if (!await inventoryEventVersionExists(
      params.client,
      params.tenantId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.eventVersion
    )) {
      events.push(event);
    }
  }

  return {
    responseBody: aggregateView,
    responseStatus: params.responseStatus ?? 200,
    events
  };
}

type DeterministicMovementLineIdentity = {
  tenantId: string;
  warehouseId: string;
  locationId: string;
  itemId: string;
  canonicalUom: string;
  sourceLineId: string;
};

function compareDeterministicMovementLineIdentity(
  left: DeterministicMovementLineIdentity,
  right: DeterministicMovementLineIdentity
) {
  return (
    left.tenantId.localeCompare(right.tenantId)
    || left.warehouseId.localeCompare(right.warehouseId)
    || left.locationId.localeCompare(right.locationId)
    || left.itemId.localeCompare(right.itemId)
    || left.canonicalUom.localeCompare(right.canonicalUom)
    || left.sourceLineId.localeCompare(right.sourceLineId)
  );
}

export function sortDeterministicMovementLines<T>(
  lines: T[],
  getIdentity: (line: T) => DeterministicMovementLineIdentity
) {
  return [...lines].sort((left, right) =>
    compareDeterministicMovementLineIdentity(getIdentity(left), getIdentity(right))
  );
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
