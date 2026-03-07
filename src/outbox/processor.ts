import { processInventoryEventBatch } from '../modules/platform/infrastructure/inventoryEvents';
import { projectInventoryMovement } from './projectors/inventoryMovement.projector';

export async function processOutboxBatch(maxBatchSize?: number) {
  return processInventoryEventBatch(
    'inventory-projector',
    async (client, event) => {
      if (event.event_type === 'inventory.movement.posted') {
        await projectInventoryMovement(client, event.tenant_id, event.aggregate_id);
      }
      // Reservation change events are authoritative history but do not need
      // post-commit projection work in the current compatibility model.
    },
    maxBatchSize
  );
}
