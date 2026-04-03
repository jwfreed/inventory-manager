import { roundQuantity } from '../../lib/numbers';
import * as movementPlanner from '../../services/inventoryMovementPlanner';
import { assertWorkOrderExecutionInvariants } from '../../services/manufacturingInvariant.service';
import type {
  NormalizedBatchConsumeLine,
  NormalizedBatchProduceLine
} from '../../services/workOrderExecution.types';
import type { WorkOrderBatchPolicy } from './batchPolicy';

export type BatchStockValidationLine = Readonly<{
  warehouseId: string;
  itemId: string;
  locationId: string;
  uom: string;
  quantityToConsume: number;
}>;

export type WorkOrderBatchPlan = Readonly<{
  consumeLineBySourceId: ReadonlyMap<string, NormalizedBatchConsumeLine>;
  produceLineBySourceId: ReadonlyMap<string, NormalizedBatchProduceLine>;
  consumePlannerLines: ReadonlyArray<movementPlanner.RawMovementLineDescriptor>;
  producePlannerLines: ReadonlyArray<movementPlanner.RawMovementLineDescriptor>;
  sortedConsumes: ReadonlyArray<movementPlanner.PlannedWorkOrderMovementLine>;
  sortedProduces: ReadonlyArray<movementPlanner.PlannedWorkOrderMovementLine>;
  validationLines: ReadonlyArray<BatchStockValidationLine>;
  producedTotal: number;
  producedCanonicalTotal: number;
}>;

function buildSourceLineId(parts: Array<string | number>) {
  return parts.join(':');
}

export async function planWorkOrderBatch(params: {
  tenantId: string;
  workOrderId: string;
  policy: WorkOrderBatchPolicy;
  client: Parameters<typeof movementPlanner.planMovementLines>[0]['client'];
}): Promise<WorkOrderBatchPlan> {
  const consumeLineBySourceId = new Map<string, NormalizedBatchConsumeLine>();
  const consumePlannerLines: movementPlanner.RawMovementLineDescriptor[] = params.policy.consumeLinesOrdered.map((line) => {
    const sourceLineId = buildSourceLineId([
      line.componentItemId,
      line.fromLocationId,
      line.uom,
      line.quantity
    ]);
    consumeLineBySourceId.set(sourceLineId, line);
    return {
      sourceLineId,
      warehouseId: params.policy.warehouseByLocationId.get(line.fromLocationId) ?? '',
      itemId: line.componentItemId,
      locationId: line.fromLocationId,
      quantity: -line.quantity,
      uom: line.uom,
      defaultReasonCode: params.policy.isDisassembly ? 'disassembly_issue' : 'work_order_issue',
      explicitReasonCode: line.reasonCode,
      lineNotes: line.notes ?? null
    };
  });

  const produceLineBySourceId = new Map<string, NormalizedBatchProduceLine>();
  const producePlannerLines: movementPlanner.RawMovementLineDescriptor[] = params.policy.produceLinesOrdered.map((line) => {
    const sourceLineId = buildSourceLineId([
      line.outputItemId,
      line.toLocationId,
      line.uom,
      line.quantity
    ]);
    produceLineBySourceId.set(sourceLineId, line);
    return {
      sourceLineId,
      warehouseId: params.policy.warehouseByLocationId.get(line.toLocationId) ?? '',
      itemId: line.outputItemId,
      locationId: line.toLocationId,
      quantity: line.quantity,
      uom: line.uom,
      defaultReasonCode: params.policy.isDisassembly ? 'disassembly_completion' : 'work_order_completion',
      explicitReasonCode: line.reasonCode,
      lineNotes: line.notes ?? null
    };
  });

  const [sortedConsumes, sortedProduces] = await Promise.all([
    movementPlanner.planMovementLines({
      tenantId: params.tenantId,
      lines: consumePlannerLines,
      client: params.client
    }),
    movementPlanner.planMovementLines({
      tenantId: params.tenantId,
      lines: producePlannerLines,
      client: params.client
    })
  ]);

  await assertWorkOrderExecutionInvariants({
    tenantId: params.tenantId,
    workOrder: params.policy.workOrder,
    consumeLines: sortedConsumes.map((entry) => ({
      itemId: entry.itemId,
      locationId: entry.locationId,
      uom: entry.canonicalFields.canonicalUom,
      quantity: Math.abs(entry.canonicalFields.quantityDeltaCanonical),
      reasonCode: entry.reasonCode
    })),
    produceLines: sortedProduces.map((entry) => ({
      itemId: entry.itemId,
      locationId: entry.locationId,
      uom: entry.canonicalFields.canonicalUom,
      quantity: entry.canonicalFields.quantityDeltaCanonical,
      reasonCode: entry.reasonCode
    })),
    client: params.client
  });

  const producedTotal = params.policy.produceLinesOrdered.reduce(
    (sum, line) => roundQuantity(sum + line.quantity),
    0
  );
  const producedCanonicalTotal = sortedProduces.reduce(
    (sum, line) => roundQuantity(sum + line.canonicalFields.quantityDeltaCanonical),
    0
  );

  const reservationOpenByKey = new Map(
    params.policy.reservationSnapshot.map((line) => [
      `${line.componentItemId}:${line.locationId}:${line.uom}`,
      line.openReservedQty
    ])
  );
  const validationByKey = new Map<
    string,
    { warehouseId: string; itemId: string; locationId: string; uom: string; requestedQty: number }
  >();
  for (const preparedConsume of sortedConsumes) {
    const key = `${preparedConsume.itemId}:${preparedConsume.locationId}:${preparedConsume.canonicalFields.canonicalUom}`;
    const requestedQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
    const existing = validationByKey.get(key);
    if (existing) {
      existing.requestedQty = roundQuantity(existing.requestedQty + requestedQty);
    } else {
      validationByKey.set(key, {
        warehouseId: preparedConsume.warehouseId,
        itemId: preparedConsume.itemId,
        locationId: preparedConsume.locationId,
        uom: preparedConsume.canonicalFields.canonicalUom,
        requestedQty
      });
    }
  }
  const validationLines = Object.freeze(
    Array.from(validationByKey.entries())
      .map(([key, line]) => ({
        warehouseId: line.warehouseId,
        itemId: line.itemId,
        locationId: line.locationId,
        uom: line.uom,
        quantityToConsume: roundQuantity(
          Math.max(0, line.requestedQty - (reservationOpenByKey.get(key) ?? 0))
        )
      }))
      .filter((line) => line.quantityToConsume > 1e-6)
  );

  return Object.freeze({
    consumeLineBySourceId,
    produceLineBySourceId,
    consumePlannerLines: Object.freeze(consumePlannerLines.map((line) => Object.freeze({ ...line }))),
    producePlannerLines: Object.freeze(producePlannerLines.map((line) => Object.freeze({ ...line }))),
    sortedConsumes,
    sortedProduces,
    validationLines,
    producedTotal,
    producedCanonicalTotal
  });
}
