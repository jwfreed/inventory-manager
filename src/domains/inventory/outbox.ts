import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  appendInventoryEventWithDispatch,
  getNextInventoryEventVersion
} from '../../modules/platform/infrastructure/inventoryEvents';
import { buildInventoryRegistryEvent } from '../../modules/platform/application/inventoryEventRegistry';

export async function enqueueInventoryMovementPosted(
  client: PoolClient,
  tenantId: string,
  movementId: string,
  options?: { producerIdempotencyKey?: string | null }
) {
  const event = buildInventoryRegistryEvent('inventoryMovementPosted', {
    producerIdempotencyKey: options?.producerIdempotencyKey ?? null,
    payload: { movementId }
  });
  await appendInventoryEventWithDispatch(client, {
    tenantId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateIdSource: event.aggregateIdSource,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    payload: event.payload,
    producerIdempotencyKey: event.producerIdempotencyKey,
    dispatch: event.dispatch
  });
}

export async function enqueueInventoryReservationChanged(
  client: PoolClient,
  tenantId: string,
  reservationId: string,
  payload: { itemId?: string; locationId?: string; demandId?: string; demandType?: string; status?: string },
  options?: { eventVersion?: number; producerIdempotencyKey?: string | null }
) {
  const eventVersion = options?.eventVersion ?? await getNextInventoryEventVersion(
    client,
    tenantId,
    'inventory_reservation',
    reservationId
  );
  const event = buildInventoryRegistryEvent('inventoryReservationChanged', {
    eventVersion,
    producerIdempotencyKey: options?.producerIdempotencyKey ?? null,
    payload: { reservationId, ...payload },
    dispatch: {
      aggregateType: 'inventory_reservation_change',
      aggregateId: uuidv4()
    }
  });
  await appendInventoryEventWithDispatch(client, {
    tenantId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateIdSource: event.aggregateIdSource,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    payload: event.payload,
    producerIdempotencyKey: event.producerIdempotencyKey,
    dispatch: event.dispatch
  });
}
