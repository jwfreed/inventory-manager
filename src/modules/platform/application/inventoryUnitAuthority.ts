import { roundQuantity, toNumber } from '../../../lib/numbers';
import {
  assertInventoryStateTransition,
  type InventoryState,
  type InventoryStateTransition
} from './inventoryMovementLineSemantics';

const EPSILON = 1e-6;

export type InventoryUnitEvent = Readonly<{
  id: string;
  movementId: string;
  sourceLineId: string;
  skuId: string;
  lotId: string;
  locationId: string;
  unitOfMeasure: string;
  eventTimestamp: Date | string;
  reasonCode: string;
  stateTransition: InventoryStateTransition;
  recordQuantityDelta: number | string;
  physicalQuantityDelta?: number | string | null;
}>;

export type InventoryUnitState = Readonly<{
  skuId: string;
  lotId: string;
  locationId: string;
  unitOfMeasure: string;
  state: InventoryState;
  recordQuantity: number;
  physicalQuantity: number | null;
  firstEventTimestamp: string;
  firstEventId: string;
  lastEventTimestamp: string;
  lastEventId: string;
}>;

export type InventoryUnitConsumption = Readonly<{
  eventId: string;
  movementId: string;
  sourceLineId: string;
  skuId: string;
  lotId: string;
  locationId: string;
  unitOfMeasure: string;
  quantity: number;
  eventTimestamp: string;
}>;

export function compareInventoryEventOrder(
  left: Pick<InventoryUnitEvent, 'eventTimestamp' | 'id'>,
  right: Pick<InventoryUnitEvent, 'eventTimestamp' | 'id'>
): number {
  const leftTime = new Date(left.eventTimestamp).getTime();
  const rightTime = new Date(right.eventTimestamp).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new Error('INVENTORY_EVENT_TIMESTAMP_INVALID');
  }
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

function assertInventoryUnitEventIntegrity(event: InventoryUnitEvent): void {
  if (!event.movementId) throw new Error('INVENTORY_UNIT_EVENT_MOVEMENT_ID_REQUIRED');
  if (!event.sourceLineId) throw new Error('INVENTORY_UNIT_EVENT_SOURCE_LINE_ID_REQUIRED');
  if (!event.reasonCode?.trim()) throw new Error('INVENTORY_UNIT_EVENT_REASON_CODE_REQUIRED');
  if (!event.eventTimestamp) throw new Error('INVENTORY_UNIT_EVENT_TIMESTAMP_REQUIRED');
  if (!event.skuId || !event.lotId || !event.locationId || !event.unitOfMeasure) {
    throw new Error('INVENTORY_UNIT_EVENT_SCOPE_REQUIRED');
  }

  const [fromState, toState] = event.stateTransition.split('->') as [InventoryState, InventoryState];
  assertInventoryStateTransition(fromState, toState);
}

function makeUnitKey(event: Pick<InventoryUnitEvent, 'skuId' | 'lotId' | 'locationId' | 'unitOfMeasure'>): string {
  return [event.skuId, event.lotId, event.locationId, event.unitOfMeasure].join(':');
}

export function rebuildInventoryUnitStates(events: ReadonlyArray<InventoryUnitEvent>): InventoryUnitState[] {
  const states = new Map<string, InventoryUnitState>();

  for (const event of [...events].sort(compareInventoryEventOrder)) {
    assertInventoryUnitEventIntegrity(event);
    const [fromState, toState] = event.stateTransition.split('->') as [InventoryState, InventoryState];
    const key = makeUnitKey(event);
    const current = states.get(key);
    const recordDelta = roundQuantity(toNumber(event.recordQuantityDelta));
    const physicalDelta = event.physicalQuantityDelta === null || event.physicalQuantityDelta === undefined
      ? null
      : roundQuantity(toNumber(event.physicalQuantityDelta));
    const nextRecord = roundQuantity((current?.recordQuantity ?? 0) + recordDelta);
    if (nextRecord < -EPSILON) {
      throw new Error('INVENTORY_UNIT_RECORD_QUANTITY_NEGATIVE');
    }

    const nextPhysical = physicalDelta === null
      ? current?.physicalQuantity ?? null
      : roundQuantity((current?.physicalQuantity ?? 0) + physicalDelta);
    if (nextPhysical !== null && nextPhysical < -EPSILON) {
      throw new Error('INVENTORY_UNIT_PHYSICAL_QUANTITY_NEGATIVE');
    }

    states.set(key, {
      skuId: event.skuId,
      lotId: event.lotId,
      locationId: event.locationId,
      unitOfMeasure: event.unitOfMeasure,
      state: recordDelta < 0 && nextRecord > EPSILON ? fromState : toState,
      recordQuantity: nextRecord,
      physicalQuantity: nextPhysical,
      firstEventTimestamp: current?.firstEventTimestamp ?? new Date(event.eventTimestamp).toISOString(),
      firstEventId: current?.firstEventId ?? event.id,
      lastEventTimestamp: new Date(event.eventTimestamp).toISOString(),
      lastEventId: event.id
    });
  }

  return [...states.values()].sort((left, right) =>
    left.skuId.localeCompare(right.skuId)
    || left.locationId.localeCompare(right.locationId)
    || left.unitOfMeasure.localeCompare(right.unitOfMeasure)
    || left.lotId.localeCompare(right.lotId)
  );
}

export function planFifoUnitConsumption(params: {
  events: ReadonlyArray<InventoryUnitEvent>;
  skuId: string;
  locationId: string;
  unitOfMeasure: string;
  quantity: number;
}): InventoryUnitConsumption[] {
  const requestedQuantity = roundQuantity(toNumber(params.quantity));
  if (requestedQuantity <= EPSILON) {
    throw new Error('INVENTORY_UNIT_CONSUMPTION_QUANTITY_INVALID');
  }

  const eligible = rebuildInventoryUnitStates(params.events)
    .filter((state) =>
      state.skuId === params.skuId
      && state.locationId === params.locationId
      && state.unitOfMeasure === params.unitOfMeasure
      && state.state === 'available'
      && state.recordQuantity > EPSILON
    )
    .sort((left, right) => {
      const leftTime = new Date(left.firstEventTimestamp).getTime();
      const rightTime = new Date(right.firstEventTimestamp).getTime();
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.firstEventId.localeCompare(right.firstEventId);
    });

  let remaining = requestedQuantity;
  const consumption: InventoryUnitConsumption[] = [];

  for (const unit of eligible) {
    if (remaining <= EPSILON) break;
    const quantity = roundQuantity(Math.min(unit.recordQuantity, remaining));
    const sourceEvent = params.events.find((event) => event.id === unit.lastEventId);
    if (!sourceEvent) {
      throw new Error('INVENTORY_UNIT_SOURCE_EVENT_MISSING');
    }
    consumption.push({
      eventId: sourceEvent.id,
      movementId: sourceEvent.movementId,
      sourceLineId: sourceEvent.sourceLineId,
      skuId: unit.skuId,
      lotId: unit.lotId,
      locationId: unit.locationId,
      unitOfMeasure: unit.unitOfMeasure,
      quantity,
      eventTimestamp: unit.lastEventTimestamp
    });
    remaining = roundQuantity(remaining - quantity);
  }

  if (remaining > EPSILON) {
    throw new Error('INVENTORY_UNIT_INSUFFICIENT_AVAILABLE');
  }

  return consumption;
}
