import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  appendInventoryEventWithDispatch,
  getNextInventoryEventVersion
} from '../../modules/platform/infrastructure/inventoryEvents';

export async function enqueueInventoryMovementPosted(
  client: PoolClient,
  tenantId: string,
  movementId: string,
  options?: { producerIdempotencyKey?: string | null }
) {
  await appendInventoryEventWithDispatch(client, {
    tenantId,
    aggregateType: 'inventory_movement',
    aggregateId: movementId,
    eventType: 'inventory.movement.posted',
    eventVersion: 1,
    payload: { movementId },
    producerIdempotencyKey: options?.producerIdempotencyKey ?? null
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
  await appendInventoryEventWithDispatch(client, {
    tenantId,
    aggregateType: 'inventory_reservation',
    aggregateId: reservationId,
    eventType: 'inventory.reservation.changed',
    eventVersion,
    payload: { reservationId, ...payload },
    producerIdempotencyKey: options?.producerIdempotencyKey ?? null,
    dispatch: {
      aggregateType: 'inventory_reservation_change',
      aggregateId: uuidv4()
    }
  });
}
