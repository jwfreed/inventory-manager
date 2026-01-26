import type { PoolClient } from 'pg';
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
