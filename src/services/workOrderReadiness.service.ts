import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { deriveWorkOrderStageRouting } from './stageRouting.service';
import { getWorkOrderExecutionSummary } from './workOrderExecution.service';
import { getWorkOrderReservationSnapshot } from './inventoryReservation.service';

type AvailableElsewhereRow = {
  location_id: string;
  location_code: string | null;
  location_name: string | null;
  warehouse_id: string;
  uom: string;
  available_qty: string | number;
};

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

async function loadAvailableElsewhereByLine(
  tenantId: string,
  lines: Awaited<ReturnType<typeof getWorkOrderReservationSnapshot>>
) {
  const result = new Map<string, {
    locationId: string;
    locationCode: string | null;
    locationName: string | null;
    warehouseId: string;
    uom: string;
    available: number;
  }[]>();

  await Promise.all(
    lines.map(async (line) => {
      const rows = await query<AvailableElsewhereRow>(
        `SELECT v.location_id,
                l.code AS location_code,
                l.name AS location_name,
                v.warehouse_id,
                v.uom,
                v.available_qty
           FROM inventory_available_location_v v
           JOIN locations l
             ON l.id = v.location_id
            AND l.tenant_id = v.tenant_id
          WHERE v.tenant_id = $1
            AND v.item_id = $2
            AND v.uom = $3
            AND v.location_id <> $4
            AND v.available_qty > 0
          ORDER BY v.available_qty DESC, l.code ASC, v.location_id ASC
          LIMIT 5`,
        [tenantId, line.componentItemId, line.uom, line.locationId]
      );
      result.set(
        `${line.componentItemId}:${line.locationId}:${line.uom}`,
        rows.rows.map((row) => ({
          locationId: row.location_id,
          locationCode: row.location_code,
          locationName: row.location_name,
          warehouseId: row.warehouse_id,
          uom: row.uom,
          available: roundQuantity(toNumber(row.available_qty))
        }))
      );
    })
  );

  return result;
}

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

  const availableElsewhereByLine = await loadAvailableElsewhereByLine(tenantId, reservationSnapshot);
  const readinessLines = reservationSnapshot.map((line, index) => {
    const availableShortage = roundQuantity(Math.max(0, line.requiredQty - line.availableQty));
    return {
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
      shortage: availableShortage,
      blocked: availableShortage > 0,
      availableElsewhere: availableElsewhereByLine.get(`${line.componentItemId}:${line.locationId}:${line.uom}`) ?? [],
      reservationId: line.reservationId,
      reservationStatus: line.reservationStatus,
      fulfilled: line.fulfilledQty
    };
  });

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
