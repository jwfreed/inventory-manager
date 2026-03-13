import { query } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { getWorkOrderRequirements } from './workOrders.service';
import { deriveComponentConsumeLocation, deriveWorkOrderStageRouting } from './stageRouting.service';
import { getWorkOrderExecutionSummary } from './workOrderExecution.service';

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
  const remainingQuantity = roundQuantity(Math.max(0, plannedQuantity - producedQuantity));
  const requirements = await getWorkOrderRequirements(
    tenantId,
    workOrderId,
    remainingQuantity > 0 ? remainingQuantity : plannedQuantity
  );
  const executionSummary = await getWorkOrderExecutionSummary(tenantId, workOrderId);
  const routing = await deriveWorkOrderStageRouting(tenantId, {
    kind: workOrder.kind,
    outputItemId: workOrder.output_item_id,
    bomId: workOrder.bom_id,
    defaultConsumeLocationId: workOrder.default_consume_location_id,
    defaultProduceLocationId: workOrder.default_produce_location_id,
    produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
  });

  if (!requirements) {
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
        scrapped: roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0)),
        remaining: remainingQuantity
      },
      hasShortage: false,
      lines: []
    };
  }

  const readinessLines = await Promise.all(
    requirements.lines.map(async (line) => {
      const preferredLocation = await deriveComponentConsumeLocation(
        tenantId,
        {
          kind: workOrder.kind,
          outputItemId: workOrder.output_item_id,
          bomId: workOrder.bom_id,
          defaultConsumeLocationId: workOrder.default_consume_location_id,
          defaultProduceLocationId: workOrder.default_produce_location_id,
          produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
        },
        { componentItemId: line.componentItemId }
      );

      const availabilityRes = preferredLocation
        ? await query<{
            item_id: string;
            on_hand_qty: string | number;
            reserved_qty: string | number;
            allocated_qty: string | number;
            available_qty: string | number;
          }>(
            `SELECT item_id, on_hand_qty, reserved_qty, allocated_qty, available_qty
               FROM inventory_available_location_v
              WHERE tenant_id = $1
                AND item_id = $2
                AND location_id = $3
                AND uom = $4
              LIMIT 1`,
            [tenantId, line.componentItemId, preferredLocation.id, line.uom]
          )
        : { rows: [] };

      const availability = availabilityRes.rows[0];
      const available = roundQuantity(toNumber(availability?.available_qty ?? 0));
      const reserved = roundQuantity(toNumber(availability?.reserved_qty ?? 0) + toNumber(availability?.allocated_qty ?? 0));
      const shortage = roundQuantity(Math.max(0, line.quantityRequired - available));

      const componentRes = await query<{ sku: string | null; name: string | null }>(
        `SELECT sku, name
           FROM items
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, line.componentItemId]
      );

      return {
        ...line,
        componentItemSku: componentRes.rows[0]?.sku ?? null,
        componentItemName: componentRes.rows[0]?.name ?? null,
        consumeLocationId: preferredLocation?.id ?? null,
        consumeLocationCode: preferredLocation?.code ?? null,
        consumeLocationName: preferredLocation?.name ?? null,
        consumeLocationRole: preferredLocation?.role ?? null,
        required: line.quantityRequired,
        reserved,
        available,
        shortage,
        blocked: shortage > 0
      };
    })
  );

  const produced = producedQuantity;
  const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));
  const planned = plannedQuantity;

  return {
    workOrderId,
    stageType: routing.stageType,
    stageLabel: routing.stageLabel,
    status: workOrder.status,
    consumeLocation: routing.defaultConsumeLocation,
    produceLocation: routing.defaultProduceLocation,
    quantities: {
      planned,
      produced,
      scrapped,
      remaining: remainingQuantity
    },
    hasShortage: readinessLines.some((line) => line.shortage > 0),
    executionSummary,
    lines: readinessLines
  };
}
