import type { InventoryEventDispatch, InventoryEventInput } from '../infrastructure/inventoryEvents';
import type { InventoryCommandEvent } from './runInventoryCommand';

type InventoryEventRegistryDefinition = {
  aggregateType: string;
  eventType: string;
  eventVersion: number;
  aggregateIdPayloadKey: string;
};

export const INVENTORY_EVENT_REGISTRY = Object.freeze({
  inventoryMovementPosted: {
    aggregateType: 'inventory_movement',
    eventType: 'inventory.movement.posted',
    eventVersion: 1,
    aggregateIdPayloadKey: 'movementId'
  },
  inventoryCountPosted: {
    aggregateType: 'inventory_count',
    eventType: 'inventory.count.posted',
    eventVersion: 1,
    aggregateIdPayloadKey: 'countId'
  },
  inventoryAdjustmentPosted: {
    aggregateType: 'inventory_adjustment',
    eventType: 'inventory.adjustment.posted',
    eventVersion: 1,
    aggregateIdPayloadKey: 'adjustmentId'
  },
  licensePlateMoved: {
    aggregateType: 'license_plate',
    eventType: 'inventory.license_plate.moved',
    eventVersion: 1,
    aggregateIdPayloadKey: 'licensePlateId'
  },
  workOrderIssuePosted: {
    aggregateType: 'work_order_issue',
    eventType: 'inventory.work_order.issue.posted',
    eventVersion: 1,
    aggregateIdPayloadKey: 'issueId'
  },
  workOrderCompletionPosted: {
    aggregateType: 'work_order_execution',
    eventType: 'inventory.work_order.completion.posted',
    eventVersion: 1,
    aggregateIdPayloadKey: 'executionId'
  },
  workOrderProductionReported: {
    aggregateType: 'work_order_execution',
    eventType: 'inventory.work_order.production.reported',
    eventVersion: 1,
    aggregateIdPayloadKey: 'executionId'
  },
  workOrderProductionReversed: {
    aggregateType: 'work_order_execution',
    eventType: 'inventory.work_order.production.reversed',
    eventVersion: 1,
    aggregateIdPayloadKey: 'executionId'
  },
  workOrderWipValuationRecorded: {
    aggregateType: 'work_order_execution',
    eventType: 'inventory.work_order.wip_valuation.recorded',
    eventVersion: 1,
    aggregateIdPayloadKey: 'movementId'
  }
} as const satisfies Record<string, InventoryEventRegistryDefinition>);

export type InventoryEventRegistryName = keyof typeof INVENTORY_EVENT_REGISTRY;

function resolveRegistryDefinition(name: InventoryEventRegistryName) {
  return INVENTORY_EVENT_REGISTRY[name];
}

function resolveAggregateIdFromPayload(
  payload: Record<string, unknown> | undefined,
  payloadKey: string
): string {
  const aggregateId = payload?.[payloadKey];
  if (typeof aggregateId !== 'string' || !aggregateId.trim()) {
    throw new Error(`INVENTORY_EVENT_AGGREGATE_ID_REQUIRED:${payloadKey}`);
  }
  return aggregateId;
}

export function buildInventoryRegistryEvent(
  name: InventoryEventRegistryName,
  params: {
    payload: Record<string, unknown>;
    producerIdempotencyKey?: string | null;
    dispatch?: InventoryEventDispatch;
  }
): InventoryCommandEvent {
  const definition = resolveRegistryDefinition(name);
  return {
    aggregateType: definition.aggregateType,
    aggregateId: resolveAggregateIdFromPayload(params.payload, definition.aggregateIdPayloadKey),
    eventType: definition.eventType,
    eventVersion: definition.eventVersion,
    payload: params.payload,
    producerIdempotencyKey: params.producerIdempotencyKey ?? null,
    dispatch: params.dispatch
  };
}

export function validateInventoryEventRegistryInput(
  input: Pick<
    InventoryEventInput,
    'aggregateType' | 'aggregateId' | 'eventType' | 'eventVersion' | 'payload'
  >
): InventoryEventRegistryDefinition {
  const definition = Object.values(INVENTORY_EVENT_REGISTRY).find(
    (candidate) =>
      candidate.aggregateType === input.aggregateType
      && candidate.eventType === input.eventType
      && candidate.eventVersion === input.eventVersion
  );
  if (!definition) {
    throw new Error(
      `INVENTORY_EVENT_REGISTRY_MISSING:${input.aggregateType}:${input.eventType}:v${input.eventVersion}`
    );
  }
  const expectedAggregateId = resolveAggregateIdFromPayload(
    input.payload ?? {},
    definition.aggregateIdPayloadKey
  );
  if (expectedAggregateId !== input.aggregateId) {
    throw new Error(
      `INVENTORY_EVENT_AGGREGATE_ID_MISMATCH:${input.eventType}:expected=${expectedAggregateId}:received=${input.aggregateId}`
    );
  }
  return definition;
}
