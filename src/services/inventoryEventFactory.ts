import { roundQuantity } from '../lib/numbers';
import { buildMovementPostedEvent } from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';
import type { InventoryCommandEvent } from '../modules/platform/application/runInventoryCommand';
import type { WipValuationType } from './workOrderExecution.types';

export function buildInventoryMovementPostedEvent(
  movementId: string,
  producerIdempotencyKey?: string | null
) {
  return buildMovementPostedEvent(movementId, producerIdempotencyKey);
}

export function buildWorkOrderIssuePostedEvent(params: {
  issueId: string;
  workOrderId: string;
  movementId: string;
  producerIdempotencyKey?: string | null;
}): InventoryCommandEvent {
  return buildInventoryRegistryEvent('workOrderIssuePosted', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      issueId: params.issueId,
      workOrderId: params.workOrderId,
      movementId: params.movementId
    }
  });
}

export function buildWorkOrderCompletionPostedEvent(params: {
  executionId: string;
  workOrderId: string;
  movementId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('workOrderCompletionPosted', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      executionId: params.executionId,
      workOrderId: params.workOrderId,
      movementId: params.movementId
    }
  });
}

export function buildWorkOrderProductionReportedEvent(params: {
  executionId: string;
  workOrderId: string;
  issueMovementId: string;
  receiveMovementId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('workOrderProductionReported', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      executionId: params.executionId,
      workOrderId: params.workOrderId,
      issueMovementId: params.issueMovementId,
      receiveMovementId: params.receiveMovementId
    }
  });
}

export function buildWorkOrderProductionReversedEvent(params: {
  executionId: string;
  workOrderId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('workOrderProductionReversed', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      executionId: params.executionId,
      workOrderId: params.workOrderId,
      componentReturnMovementId: params.componentReturnMovementId,
      outputReversalMovementId: params.outputReversalMovementId
    }
  });
}

export function buildWorkOrderWipValuationRecordedEvent(params: {
  executionId?: string | null;
  workOrderId: string;
  movementId: string;
  valuationType: WipValuationType;
  valueDelta: number;
  producerIdempotencyKey?: string | null;
}) {
  return buildInventoryRegistryEvent('workOrderWipValuationRecorded', {
    producerIdempotencyKey: params.producerIdempotencyKey,
    payload: {
      executionId: params.executionId ?? null,
      workOrderId: params.workOrderId,
      movementId: params.movementId,
      valuationType: params.valuationType,
      valueDelta: roundQuantity(params.valueDelta)
    }
  });
}
