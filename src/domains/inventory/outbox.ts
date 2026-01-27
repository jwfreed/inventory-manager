import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { enqueueOutboxEvent } from '../../outbox/outbox.service';

export async function enqueueInventoryMovementPosted(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  await enqueueOutboxEvent(client, {
    tenantId,
    aggregateType: 'inventory_movement',
    aggregateId: movementId,
    eventType: 'inventory.movement.posted',
    payload: { movementId }
  });
}

export async function enqueueInventoryReservationChanged(
  client: PoolClient,
  tenantId: string,
  reservationId: string,
  payload: { itemId?: string; locationId?: string; demandId?: string; demandType?: string }
) {
  await enqueueOutboxEvent(client, {
    tenantId,
    aggregateType: 'inventory_reservation_change',
    aggregateId: uuidv4(),
    eventType: 'inventory.reservation.changed',
    payload: { reservationId, ...payload }
  });
}
