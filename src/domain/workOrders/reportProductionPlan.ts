import {
  deriveComponentConsumeLocation
} from '../../services/stageRouting.service';
import type { WorkOrderBatchTraceabilityRequest } from './batchExecution';
import type { ReportProductionPolicy } from './reportProductionPolicy';

export type ReportProductionPlan = Readonly<{
  consumeLines: ReadonlyArray<{
    componentItemId: string;
    fromLocationId: string;
    uom: string;
    quantity: number;
    reasonCode: string;
    notes?: string;
  }>;
  produceLines: ReadonlyArray<{
    outputItemId: string;
    toLocationId: string;
    uom: string;
    quantity: number;
    reasonCode: string;
  }>;
  traceability: WorkOrderBatchTraceabilityRequest;
}>;

export async function buildReportProductionPlan(params: {
  tenantId: string;
  workOrderId: string;
  policy: ReportProductionPolicy;
}): Promise<ReportProductionPlan> {
  const consumeLines = await Promise.all(
    params.policy.requirements.lines.map(async (line) => {
      const override = params.policy.overrides.get(line.componentItemId);
      const quantity = override ? override.quantity : line.quantityRequired;
      if (quantity < 0) {
        throw new Error('WO_REPORT_OVERRIDE_NEGATIVE_COMPONENT_QTY');
      }
      if (quantity === 0) {
        return null;
      }
      const consumeLocation = await deriveComponentConsumeLocation(
        params.tenantId,
        {
          kind: params.policy.workOrder.kind,
          outputItemId: params.policy.workOrder.outputItemId,
          bomId: params.policy.workOrder.bomId,
          defaultConsumeLocationId: params.policy.workOrder.defaultConsumeLocationId,
          defaultProduceLocationId: params.policy.workOrder.defaultProduceLocationId,
          produceToLocationIdSnapshot: params.policy.workOrder.produceToLocationIdSnapshot
        },
        { componentItemId: line.componentItemId }
      );
      if (!consumeLocation) {
        throw new Error('WO_REPORT_DEFAULT_LOCATIONS_REQUIRED');
      }
      return Object.freeze({
        componentItemId: line.componentItemId,
        fromLocationId: consumeLocation.id,
        uom: override?.uom ?? line.uom,
        quantity,
        reasonCode: override ? 'work_order_backflush_override' : 'work_order_backflush',
        notes: override?.reason ?? undefined
      });
    })
  );
  const resolvedConsumeLines = Object.freeze(
    consumeLines.filter((line): line is NonNullable<typeof line> => line !== null)
  );
  if (resolvedConsumeLines.length === 0) {
    throw new Error('WO_REPORT_NO_COMPONENT_CONSUMPTION');
  }

  if (params.policy.inputLots.length > 0) {
    const consumableComponentIds = new Set(
      resolvedConsumeLines.map((line) => line.componentItemId)
    );
    for (const inputLot of params.policy.inputLots) {
      if (!consumableComponentIds.has(inputLot.componentItemId)) {
        throw new Error('WO_REPORT_INPUT_LOT_COMPONENT_UNKNOWN');
      }
    }
  }

  return Object.freeze({
    consumeLines: resolvedConsumeLines,
    produceLines: Object.freeze([
      Object.freeze({
        outputItemId: params.policy.workOrder.outputItemId,
        toLocationId: params.policy.produceLocationId,
        uom: params.policy.outputUom,
        quantity: params.policy.outputQty,
        reasonCode: 'work_order_production_receipt'
      })
    ]),
    traceability: Object.freeze({
      outputItemId: params.policy.workOrder.outputItemId,
      outputQty: params.policy.outputQty,
      outputUom: params.policy.outputUom,
      outputLotId: params.policy.outputLotId,
      outputLotCode: params.policy.outputLotCode,
      productionBatchId: params.policy.productionBatchId,
      inputLots: params.policy.inputLots,
      workOrderNumber: params.policy.workOrder.number ?? params.policy.workOrder.id,
      occurredAt: params.policy.occurredAt
    })
  });
}
