import type { PoolClient } from 'pg';
import { withOutboxEventLock, markOutboxEventComplete, markOutboxEventFailed } from './outbox.service';
import { projectInventoryMovementFromOutbox } from './projectors/inventoryMovement.projector';

export async function processOutboxBatch(maxBatchSize?: number) {
  const limit = maxBatchSize ?? Number(process.env.OUTBOX_BATCH_SIZE ?? 25);
  let processed = 0;

  while (processed < limit) {
    const result = await withOutboxEventLock(async (client: PoolClient, event) => {
      try {
        if (event.event_type === 'inventory.movement.posted') {
          await projectInventoryMovementFromOutbox(client, event.tenant_id, event.aggregate_id);
        }
        await markOutboxEventComplete(client, event.id);
      } catch (error) {
        await markOutboxEventFailed(client, event, error as Error);
      }
    });

    if (result === null) {
      break;
    }
    processed += 1;
  }

  return processed;
}
