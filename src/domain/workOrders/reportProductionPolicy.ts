import { query } from '../../db';
import { roundQuantity, toNumber } from '../../lib/numbers';
import {
  deriveWorkOrderStageRouting
} from '../../services/stageRouting.service';
import {
  getWorkOrderById,
  getWorkOrderRequirements
} from '../../services/workOrders.service';
import {
  compareNormalizedOverrideKey
} from '../../services/workOrderExecution.ordering';
import {
  resolveReportProductionIdempotencyKey
} from '../../services/workOrderExecution.request';
import type {
  WorkOrderInputLotLink
} from '../../services/lotTraceabilityEngine';

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

type ReportProductionData = {
  warehouseId?: string;
  outputQty: number;
  outputUom?: string;
  outputLotId?: string;
  outputLotCode?: string;
  productionBatchId?: string;
  inputLots?: Array<{
    componentItemId: string;
    lotId: string;
    uom: string;
    quantity: number;
  }>;
  occurredAt?: string;
  notes?: string;
  clientRequestId?: string;
  idempotencyKey?: string;
  consumptionOverrides?: Array<{
    componentItemId: string;
    uom: string;
    quantity: number;
    reason?: string;
  }>;
  scrapOutputs?: Array<unknown>;
};

type ReportProductionWorkOrder = NonNullable<Awaited<ReturnType<typeof getWorkOrderById>>>;
type ReportProductionRequirements = NonNullable<Awaited<ReturnType<typeof getWorkOrderRequirements>>>;

export type ReportProductionPolicy = Readonly<{
  reportIdempotencyKey: string | null;
  workOrder: ReportProductionWorkOrder;
  requirements: ReportProductionRequirements;
  outputQty: number;
  outputUom: string;
  occurredAt: Date;
  produceLocationId: string;
  overrides: ReadonlyMap<
    string,
    {
      componentItemId: string;
      uom: string;
      quantity: number;
      reason: string | null;
    }
  >;
  inputLots: ReadonlyArray<WorkOrderInputLotLink>;
  outputLotId: string | null;
  outputLotCode: string | null;
  productionBatchId: string | null;
  notes: string | null;
}>;

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  error.details = details;
  return error;
}

export async function evaluateReportProductionPolicy(params: {
  tenantId: string;
  workOrderId: string;
  data: ReportProductionData;
  options?: { idempotencyKey?: string | null };
}): Promise<ReportProductionPolicy> {
  const reportIdempotencyKey = resolveReportProductionIdempotencyKey(
    params.workOrderId,
    params.data,
    params.options
  );
  const outputQty = toNumber(params.data.outputQty);
  if (!(outputQty > 0)) {
    throw new Error('WO_REPORT_INVALID_OUTPUT_QTY');
  }
  if (Array.isArray(params.data.scrapOutputs) && params.data.scrapOutputs.length > 0) {
    throw new Error('WO_REPORT_SCRAP_NOT_SUPPORTED');
  }

  const workOrder = await getWorkOrderById(params.tenantId, params.workOrderId);
  if (!workOrder) {
    throw new Error('WO_NOT_FOUND');
  }
  if (workOrder.kind !== 'production') {
    throw new Error('WO_REPORT_KIND_UNSUPPORTED');
  }

  const outputUom = params.data.outputUom?.trim() || workOrder.outputUom;
  if (outputUom !== workOrder.outputUom) {
    throw new Error('WO_REPORT_OUTPUT_UOM_MISMATCH');
  }

  const occurredAt = params.data.occurredAt ? new Date(params.data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('WO_REPORT_INVALID_OCCURRED_AT');
  }

  if (params.data.warehouseId) {
    const sellableDefaultRes = await query<{ location_id: string; is_sellable: boolean }>(
      `SELECT wdl.location_id, l.is_sellable
         FROM warehouse_default_location wdl
         JOIN locations l
           ON l.id = wdl.location_id
          AND l.tenant_id = wdl.tenant_id
        WHERE wdl.tenant_id = $1
          AND wdl.warehouse_id = $2
          AND wdl.role = 'SELLABLE'
        LIMIT 1`,
      [params.tenantId, params.data.warehouseId]
    );
    if (!sellableDefaultRes.rows[0]?.is_sellable) {
      throw domainError('MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE', {
        workOrderId: params.workOrderId,
        warehouseId: params.data.warehouseId,
        locationId: sellableDefaultRes.rows[0]?.location_id ?? null
      });
    }
  }

  const routing = await deriveWorkOrderStageRouting(params.tenantId, {
    kind: workOrder.kind,
    outputItemId: workOrder.outputItemId,
    bomId: workOrder.bomId,
    defaultConsumeLocationId: workOrder.defaultConsumeLocationId,
    defaultProduceLocationId: workOrder.defaultProduceLocationId,
    produceToLocationIdSnapshot: workOrder.produceToLocationIdSnapshot
  });
  const produceLocationId = workOrder.reportProductionReceiveToLocationId
    ?? routing.defaultProduceLocation?.id
    ?? null;
  if (!produceLocationId) {
    throw new Error('WO_REPORT_DEFAULT_LOCATIONS_REQUIRED');
  }

  const requirements = await getWorkOrderRequirements(
    params.tenantId,
    params.workOrderId,
    outputQty
  );
  if (!requirements) {
    throw new Error('WO_NOT_FOUND');
  }
  if (!Array.isArray(requirements.lines) || requirements.lines.length === 0) {
    throw new Error('WO_BOM_NO_LINES');
  }

  const overrides = new Map<
    string,
    {
      componentItemId: string;
      uom: string;
      quantity: number;
      reason: string | null;
    }
  >();
  if (Array.isArray(params.data.consumptionOverrides)) {
    for (const override of [...params.data.consumptionOverrides].sort(compareNormalizedOverrideKey)) {
      if (overrides.has(override.componentItemId)) {
        throw new Error('WO_REPORT_OVERRIDE_DUPLICATE_COMPONENT');
      }
      overrides.set(override.componentItemId, {
        componentItemId: override.componentItemId,
        uom: override.uom,
        quantity: roundQuantity(toNumber(override.quantity)),
        reason: override.reason?.trim() || null
      });
    }
  }

  const inputLots = Object.freeze(
    Array.isArray(params.data.inputLots)
      ? params.data.inputLots.map((inputLot) => ({
        componentItemId: inputLot.componentItemId,
        lotId: inputLot.lotId,
        uom: inputLot.uom,
        quantity: roundQuantity(toNumber(inputLot.quantity))
      }))
      : []
  );

  return Object.freeze({
    reportIdempotencyKey,
    workOrder,
    requirements,
    outputQty,
    outputUom,
    occurredAt,
    produceLocationId,
    overrides,
    inputLots,
    outputLotId: params.data.outputLotId ?? null,
    outputLotCode: params.data.outputLotCode?.trim() || null,
    productionBatchId: params.data.productionBatchId?.trim() || null,
    notes: params.data.notes ?? null
  });
}
