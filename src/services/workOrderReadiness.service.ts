import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { deriveWorkOrderStageRouting } from './stageRouting.service';
import { getWorkOrderExecutionSummary } from './workOrderExecution.service';
import { getWorkOrderReservationSnapshot } from './inventoryReservation.service';

type WorkOrderRow = {
  id: string;
  kind: string;
  status: string;
  bom_id: string | null;
  output_item_id: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  output_uom: string;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  produce_to_location_id_snapshot: string | null;
};

export async function getWorkOrderReadiness(tenantId: string, workOrderId: string) {
  const workOrderRes = await query<WorkOrderRow>(
    `SELECT id, kind, status, bom_id, output_item_id, quantity_planned, quantity_completed, quantity_scrapped, output_uom,
            default_consume_location_id, default_produce_location_id, produce_to_location_id_snapshot
       FROM work_orders
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, workOrderId]
  );
  if (workOrderRes.rowCount === 0) return null;
  const workOrder = workOrderRes.rows[0];
  const plannedQuantity = roundQuantity(toNumber(workOrder.quantity_planned));
  const producedQuantity = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
  const scrappedQuantity = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));
  const remainingQuantity = roundQuantity(Math.max(0, plannedQuantity - producedQuantity - scrappedQuantity));
  const executionSummary = await getWorkOrderExecutionSummary(tenantId, workOrderId);
  const routing = await deriveWorkOrderStageRouting(tenantId, {
    kind: workOrder.kind,
    outputItemId: workOrder.output_item_id,
    bomId: workOrder.bom_id,
    defaultConsumeLocationId: workOrder.default_consume_location_id,
    defaultProduceLocationId: workOrder.default_produce_location_id,
    produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
  });
  const reservationSnapshot = await getWorkOrderReservationSnapshot(tenantId, workOrderId);

  if (reservationSnapshot.length === 0) {
    return {
      workOrderId,
      stageType: routing.stageType,
      stageLabel: routing.stageLabel,
      status: workOrder.status,
      consumeLocation: routing.defaultConsumeLocation,
      produceLocation: routing.defaultProduceLocation,
      quantities: {
        planned: plannedQuantity,
        produced: producedQuantity,
        scrapped: scrappedQuantity,
        remaining: remainingQuantity
      },
      hasShortage: false,
      reservations: [],
      lines: []
    };
  }

  const readinessLines = reservationSnapshot.map((line, index) => ({
    lineNumber: index + 1,
    componentItemId: line.componentItemId,
    componentItemSku: line.componentItemSku,
    componentItemName: line.componentItemName,
    uom: line.uom,
    quantityRequired: line.requiredQty,
    usesPackSize: false,
    variableUom: null,
    scrapFactor: null,
    consumeLocationId: line.locationId,
    consumeLocationCode: line.locationCode,
    consumeLocationName: line.locationName,
    consumeLocationRole: line.locationRole,
    required: line.requiredQty,
    reserved: line.openReservedQty,
    available: line.availableQty,
    shortage: line.shortageQty,
    blocked: line.shortageQty > 0,
    reservationId: line.reservationId,
    reservationStatus: line.reservationStatus,
    fulfilled: line.fulfilledQty
  }));

  return {
    workOrderId,
    stageType: routing.stageType,
    stageLabel: routing.stageLabel,
    status: workOrder.status,
    consumeLocation: routing.defaultConsumeLocation,
    produceLocation: routing.defaultProduceLocation,
    quantities: {
      planned: plannedQuantity,
      produced: producedQuantity,
      scrapped: scrappedQuantity,
      remaining: remainingQuantity
    },
    hasShortage: readinessLines.some((line) => line.shortage > 0),
    executionSummary,
    reservations: reservationSnapshot.map((line) => ({
      id: line.reservationId,
      status: line.reservationStatus,
      componentItemId: line.componentItemId,
      componentItemSku: line.componentItemSku,
      componentItemName: line.componentItemName,
      locationId: line.locationId,
      locationCode: line.locationCode,
      locationName: line.locationName,
      uom: line.uom,
      requiredQty: line.requiredQty,
      reservedQty: line.openReservedQty,
      fulfilledQty: line.fulfilledQty
    })),
    lines: readinessLines
  };
}
