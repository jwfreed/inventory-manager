import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { createHash } from 'crypto';
import { query, withTransaction, withTransactionRetry } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import { getWorkOrderById, getWorkOrderRequirements } from './workOrders.service';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock } from './stockValidation.service';
import {
  applyPlannedCostLayerConsumption,
  createCostLayer,
  planCostLayerConsumption
} from './costLayers.service';
import { getCanonicalMovementFields, type CanonicalMovementFields } from './uomCanonical.service';
import { getWarehouseDefaultLocationId, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema,
  workOrderReportProductionSchema,
  workOrderReportScrapSchema,
  workOrderVoidReportProductionSchema
} from '../schemas/workOrderExecution.schema';
import {
  buildTransferLockTargets,
  buildTransferReplayResult,
  executeTransferInventoryMutation,
  prepareTransferMutation,
  type PreparedTransferMutation
} from './transfers.service';
import {
  hashTransactionalIdempotencyRequest
} from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildInventoryBalanceProjectionOp,
  buildReplayCorruptionError,
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';
import {
  isTerminalWorkOrderStatus,
  nextStatusAfterExecutionStart,
  nextStatusFromProgress,
  normalizeWorkOrderStatus
} from './workOrderLifecycle.service';
import {
  assertWorkOrderRoutingLine,
  deriveComponentConsumeLocation,
  deriveWorkOrderStageRouting
} from './stageRouting.service';
import {
  consumeWorkOrderReservations,
  ensureWorkOrderReservationsReady
} from './inventoryReservation.service';
import { assertWorkOrderExecutionInvariants } from './manufacturingInvariant.service';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;
type WorkOrderReportProductionInput = z.infer<typeof workOrderReportProductionSchema>;
type WorkOrderReportProductionInputLot = NonNullable<WorkOrderReportProductionInput['inputLots']>[number];
type WorkOrderVoidReportProductionInput = z.infer<typeof workOrderVoidReportProductionSchema>;
type WorkOrderReportScrapInput = z.infer<typeof workOrderReportScrapSchema>;

const WIP_COST_METHOD = 'fifo';
const WIP_INTEGRITY_EPSILON = 1e-6;
const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };
const FORCED_LOT_LINK_FAILURE_KEYS = new Set<string>();

type DomainError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

function domainError(code: string, details?: Record<string, unknown>): DomainError {
  const error = new Error(code) as DomainError;
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function workOrderRoutingContext(workOrder: WorkOrderRow) {
  return {
    kind: workOrder.kind,
    outputItemId: workOrder.output_item_id,
    bomId: workOrder.bom_id,
    defaultConsumeLocationId: workOrder.default_consume_location_id,
    defaultProduceLocationId: workOrder.default_produce_location_id,
    produceToLocationIdSnapshot: workOrder.produce_to_location_id_snapshot
  };
}

type ManufacturingMutationState =
  | 'planned_issue'
  | 'posted_issue'
  | 'planned_completion'
  | 'reported_production'
  | 'posted_completion'
  | 'reversal';

type WipValuationType =
  | 'issue'
  | 'completion'
  | 'report'
  | 'reversal_to_wip'
  | 'reversal_from_wip';

function workOrderWipIntegrityError(details: Record<string, unknown>) {
  const error = new Error('WO_WIP_INTEGRITY_FAILED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'WO_WIP_INTEGRITY_FAILED';
  error.details = details;
  return error;
}

function assertManufacturingTransition(params: {
  flow: string;
  currentState: ManufacturingMutationState;
  allowedFrom: ManufacturingMutationState[];
  targetState: ManufacturingMutationState;
  workOrderId: string;
  executionOrDocumentId: string;
}) {
  if (params.allowedFrom.includes(params.currentState)) {
    return;
  }
  throw domainError('WO_INVALID_STATE', {
    flow: params.flow,
    workOrderId: params.workOrderId,
    executionOrDocumentId: params.executionOrDocumentId,
    currentState: params.currentState,
    allowedFrom: params.allowedFrom,
    targetState: params.targetState
  });
}

function deriveIssueMutationState(issue: WorkOrderMaterialIssueRow): ManufacturingMutationState {
  if (issue.status === 'draft') {
    return 'planned_issue';
  }
  if (issue.status === 'posted' && issue.inventory_movement_id) {
    return 'posted_issue';
  }
  throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
    flow: 'issue',
    issueId: issue.id,
    reason: issue.status === 'posted'
      ? 'posted_issue_missing_authoritative_movement'
      : 'issue_state_unrecognized'
  });
}

function deriveCompletionMutationState(params: {
  execution: WorkOrderExecutionRow | LockedExecutionRow;
  flow: 'completion' | 'report';
}): ManufacturingMutationState {
  if (params.execution.status === 'draft') {
    return 'planned_completion';
  }
  if (params.execution.status === 'posted' && params.execution.production_movement_id) {
    return params.flow === 'report' ? 'reported_production' : 'posted_completion';
  }
  throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
    flow: params.flow,
    executionId: params.execution.id,
    reason: params.execution.status === 'posted'
      ? 'posted_completion_missing_authoritative_movement'
      : 'completion_state_unrecognized'
  });
}

function buildWorkOrderIssuePostedEvent(params: {
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

function buildWorkOrderCompletionPostedEvent(params: {
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

function buildWorkOrderProductionReportedEvent(params: {
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

function buildWorkOrderProductionReversedEvent(params: {
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

function buildWorkOrderWipValuationRecordedEvent(params: {
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

function compareNullableText(a: string | null | undefined, b: string | null | undefined) {
  const left = a ?? '';
  const right = b ?? '';
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIssueLineLockKey(a: WorkOrderMaterialIssueLineRow, b: WorkOrderMaterialIssueLineRow) {
  return (
    compareNullableText(a.component_item_id, b.component_item_id) ||
    compareNullableText(a.from_location_id, b.from_location_id) ||
    compareNullableText(a.uom, b.uom) ||
    a.line_number - b.line_number ||
    compareNullableText(a.id, b.id)
  );
}

function compareProduceLineLockKey(a: WorkOrderExecutionLineRow, b: WorkOrderExecutionLineRow) {
  return (
    compareNullableText(a.item_id, b.item_id) ||
    compareNullableText(a.to_location_id, b.to_location_id) ||
    compareNullableText(a.uom, b.uom) ||
    compareNullableText(a.id, b.id)
  );
}

function compareBatchConsumeKey(
  a: {
    componentItemId: string;
    fromLocationId: string;
    uom: string;
  },
  b: {
    componentItemId: string;
    fromLocationId: string;
    uom: string;
  }
) {
  return (
    compareNullableText(a.componentItemId, b.componentItemId) ||
    compareNullableText(a.fromLocationId, b.fromLocationId) ||
    compareNullableText(a.uom, b.uom)
  );
}

function compareBatchProduceKey(
  a: {
    outputItemId: string;
    toLocationId: string;
    uom: string;
  },
  b: {
    outputItemId: string;
    toLocationId: string;
    uom: string;
  }
) {
  return (
    compareNullableText(a.outputItemId, b.outputItemId) ||
    compareNullableText(a.toLocationId, b.toLocationId) ||
    compareNullableText(a.uom, b.uom)
  );
}

function compareNormalizedOverrideKey(
  left: { componentItemId: string },
  right: { componentItemId: string }
) {
  return compareNullableText(left.componentItemId, right.componentItemId);
}

type NormalizedBatchConsumeLine = {
  componentItemId: string;
  fromLocationId: string;
  uom: string;
  quantity: number;
  reasonCode: string | null;
  notes: string | null;
};

type NormalizedBatchProduceLine = {
  outputItemId: string;
  toLocationId: string;
  uom: string;
  quantity: number;
  packSize: number | null;
  reasonCode: string | null;
  notes: string | null;
};

function normalizedBatchConsumeSortKey(line: NormalizedBatchConsumeLine) {
  return [
    line.componentItemId,
    line.fromLocationId,
    line.uom,
    line.quantity.toString(),
    line.reasonCode ?? '',
    line.notes ?? ''
  ].join('|');
}

function normalizedBatchProduceSortKey(line: NormalizedBatchProduceLine) {
  return [
    line.outputItemId,
    line.toLocationId,
    line.uom,
    line.quantity.toString(),
    line.packSize?.toString() ?? '',
    line.reasonCode ?? '',
    line.notes ?? ''
  ].join('|');
}

function normalizeBatchRequestPayload(params: {
  workOrderId: string;
  occurredAt: Date;
  notes?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  consumeLines: NormalizedBatchConsumeLine[];
  produceLines: NormalizedBatchProduceLine[];
}) {
  const normalizedConsumeLines = [...params.consumeLines]
    .map((line) => ({
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: line.uom,
      quantity: roundQuantity(line.quantity),
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    }))
    .sort((a, b) => normalizedBatchConsumeSortKey(a).localeCompare(normalizedBatchConsumeSortKey(b)));
  const normalizedProduceLines = [...params.produceLines]
    .map((line) => ({
      outputItemId: line.outputItemId,
      toLocationId: line.toLocationId,
      uom: line.uom,
      quantity: roundQuantity(line.quantity),
      packSize: line.packSize !== null ? roundQuantity(line.packSize) : null,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    }))
    .sort((a, b) => normalizedBatchProduceSortKey(a).localeCompare(normalizedBatchProduceSortKey(b)));

  return {
    workOrderId: params.workOrderId,
    occurredAt: params.occurredAt.toISOString(),
    notes: params.notes ?? null,
    overrideNegative: params.overrideNegative ?? false,
    overrideReason: params.overrideReason ?? null,
    consumeLines: normalizedConsumeLines,
    produceLines: normalizedProduceLines
  };
}

function hashNormalizedBatchRequest(payload: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

type NegativeOverrideContext = {
  actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  routing_id: string | null;
  produce_to_location_id_snapshot: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  completed_at: string | null;
  updated_at: string;
};

type WorkOrderMaterialIssueRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type WorkOrderMaterialIssueLineRow = {
  id: string;
  work_order_material_issue_id: string;
  line_number: number;
  component_item_id: string;
  uom: string;
  quantity_issued: string | number;
  from_location_id: string;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderExecutionRow = {
  id: string;
  work_order_id: string;
  occurred_at: string;
  status: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
  production_batch_id: string | null;
  output_lot_id: string | null;
  wip_total_cost: string | number | null;
  wip_unit_cost: string | number | null;
  wip_quantity_canonical: string | number | null;
  wip_cost_method: string | null;
  wip_costed_at: string | null;
  notes: string | null;
  created_at: string;
};

type WorkOrderExecutionLineRow = {
  id: string;
  work_order_execution_id: string;
  line_type: string;
  item_id: string;
  uom: string;
  quantity: string | number;
  pack_size: string | number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

function mapMaterialIssue(row: WorkOrderMaterialIssueRow, lines: WorkOrderMaterialIssueLineRow[]) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      componentItemId: line.component_item_id,
      fromLocationId: line.from_location_id,
      uom: line.uom,
      quantityIssued: roundQuantity(toNumber(line.quantity_issued)),
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

function mapExecution(row: WorkOrderExecutionRow, lines: WorkOrderExecutionLineRow[]) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    status: row.status,
    occurredAt: row.occurred_at,
    consumptionMovementId: row.consumption_movement_id,
    productionMovementId: row.production_movement_id,
    wipTotalCost: row.wip_total_cost !== null ? toNumber(row.wip_total_cost) : null,
    wipUnitCost: row.wip_unit_cost !== null ? toNumber(row.wip_unit_cost) : null,
    wipQuantityCanonical: row.wip_quantity_canonical !== null ? toNumber(row.wip_quantity_canonical) : null,
    wipCostMethod: row.wip_cost_method ?? null,
    wipCostedAt: row.wip_costed_at ?? null,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineType: line.line_type,
      itemId: line.item_id,
      uom: line.uom,
      quantity: roundQuantity(toNumber(line.quantity)),
      packSize: line.pack_size !== null ? roundQuantity(toNumber(line.pack_size)) : null,
      fromLocationId: line.from_location_id,
      toLocationId: line.to_location_id,
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

async function ensurePostedMovementReady(
  client: PoolClient,
  tenantId: string,
  movementId: string
) {
  const movementRes = await client.query<{ status: string }>(
    `SELECT status
       FROM inventory_movements
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE`,
    [movementId, tenantId]
  );
  if (movementRes.rowCount === 0) {
    throw new Error('WO_POSTING_MOVEMENT_MISSING');
  }
  if (movementRes.rows[0].status !== 'posted') {
    throw new Error('WO_POSTING_IDEMPOTENCY_CONFLICT');
  }
  const lineRes = await client.query(
    `SELECT 1
       FROM inventory_movement_lines
      WHERE tenant_id = $1
        AND movement_id = $2
      LIMIT 1`,
    [tenantId, movementId]
  );
  if (lineRes.rowCount === 0) {
    throw new Error('WO_POSTING_IDEMPOTENCY_INCOMPLETE');
  }
}

type WorkOrderWipValuationRecordRow = {
  id: string;
  tenant_id: string;
  work_order_id: string;
  work_order_execution_id: string | null;
  inventory_movement_id: string;
  valuation_type: WipValuationType;
  value_delta: string | number;
  quantity_canonical: string | number | null;
  canonical_uom: string | null;
  cost_method: string | null;
  reversal_of_valuation_record_id: string | null;
  notes: string | null;
  created_at: string;
};

async function createWorkOrderWipValuationRecord(
  client: PoolClient,
  params: {
    tenantId: string;
    workOrderId: string;
    executionId?: string | null;
    movementId: string;
    valuationType: WipValuationType;
    valueDelta: number;
    quantityCanonical?: number | null;
    canonicalUom?: string | null;
    reversalOfValuationRecordId?: string | null;
    notes?: string | null;
  }
) {
  const insertResult = await client.query<WorkOrderWipValuationRecordRow>(
    `INSERT INTO work_order_wip_valuation_records (
        id,
        tenant_id,
        work_order_id,
        work_order_execution_id,
        inventory_movement_id,
        valuation_type,
        value_delta,
        quantity_canonical,
        canonical_uom,
        cost_method,
        reversal_of_valuation_record_id,
        notes,
        created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, inventory_movement_id, valuation_type) DO NOTHING
     RETURNING *`,
    [
      uuidv4(),
      params.tenantId,
      params.workOrderId,
      params.executionId ?? null,
      params.movementId,
      params.valuationType,
      roundQuantity(params.valueDelta),
      params.quantityCanonical != null ? roundQuantity(params.quantityCanonical) : null,
      params.canonicalUom ?? null,
      WIP_COST_METHOD,
      params.reversalOfValuationRecordId ?? null,
      params.notes ?? null,
      new Date()
    ]
  );
  if ((insertResult.rowCount ?? 0) > 0) {
    return insertResult.rows[0];
  }
  const existing = await client.query<WorkOrderWipValuationRecordRow>(
    `SELECT *
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND inventory_movement_id = $2
        AND valuation_type = $3
      LIMIT 1`,
    [params.tenantId, params.movementId, params.valuationType]
  );
  if (existing.rowCount === 0) {
    throw new Error('WO_WIP_VALUATION_RECORD_MISSING');
  }
  return existing.rows[0];
}

async function loadWorkOrderWipValuationRecordsByMovementIds(
  client: PoolClient,
  tenantId: string,
  movementIds: string[]
) {
  if (movementIds.length === 0) {
    return [];
  }
  const result = await client.query<WorkOrderWipValuationRecordRow>(
    `SELECT *
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND inventory_movement_id = ANY($2::uuid[])
      ORDER BY valuation_type ASC, inventory_movement_id ASC, created_at ASC, id ASC`,
    [tenantId, movementIds]
  );
  return result.rows;
}

async function verifyWorkOrderWipIntegrity(
  client: PoolClient,
  tenantId: string,
  workOrderId: string
) {
  const result = await client.query<Pick<WorkOrderWipValuationRecordRow, 'valuation_type' | 'value_delta'>>(
    `SELECT valuation_type, value_delta
       FROM work_order_wip_valuation_records
      WHERE tenant_id = $1
        AND work_order_id = $2
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`,
    [tenantId, workOrderId]
  );

  let issueValue = 0;
  let completionConsumptionValue = 0;
  let reversalToWipValue = 0;
  let reversalFromWipValue = 0;
  let signedLedgerBalance = 0;

  for (const row of result.rows) {
    const valueDelta = roundQuantity(toNumber(row.value_delta));
    signedLedgerBalance += valueDelta;
    switch (row.valuation_type) {
      case 'issue':
        if (valueDelta < -WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'issue_value_delta_negative',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        issueValue += valueDelta;
        break;
      case 'completion':
      case 'report':
        if (valueDelta > WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'completion_value_delta_positive',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        completionConsumptionValue += Math.abs(valueDelta);
        break;
      case 'reversal_to_wip':
        if (valueDelta < -WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'reversal_to_wip_negative',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        reversalToWipValue += valueDelta;
        break;
      case 'reversal_from_wip':
        if (valueDelta > WIP_INTEGRITY_EPSILON) {
          throw workOrderWipIntegrityError({
            tenantId,
            workOrderId,
            reason: 'reversal_from_wip_positive',
            valuationType: row.valuation_type,
            valueDelta
          });
        }
        reversalFromWipValue += Math.abs(valueDelta);
        break;
      default:
        throw workOrderWipIntegrityError({
          tenantId,
          workOrderId,
          reason: 'valuation_type_unrecognized',
          valuationType: row.valuation_type
        });
    }
  }

  const expectedWipBalance = roundQuantity(
    issueValue + reversalToWipValue - completionConsumptionValue - reversalFromWipValue
  );
  const normalizedSignedLedgerBalance = roundQuantity(signedLedgerBalance);
  if (
    Math.abs(expectedWipBalance - normalizedSignedLedgerBalance) > WIP_INTEGRITY_EPSILON
  ) {
    throw workOrderWipIntegrityError({
      tenantId,
      workOrderId,
      reason: 'signed_wip_balance_mismatch',
      expectedWipBalance,
      actualWipBalance: normalizedSignedLedgerBalance,
      issueValue,
      completionConsumptionValue,
      reversalToWipValue,
      reversalFromWipValue
    });
  }
  if (normalizedSignedLedgerBalance < -WIP_INTEGRITY_EPSILON) {
    throw workOrderWipIntegrityError({
      tenantId,
      workOrderId,
      reason: 'negative_wip_balance',
      actualWipBalance: normalizedSignedLedgerBalance,
      issueValue,
      completionConsumptionValue,
      reversalToWipValue,
      reversalFromWipValue
    });
  }

  return {
    issueValue,
    completionConsumptionValue,
    reversalToWipValue,
    reversalFromWipValue,
    wipBalance: normalizedSignedLedgerBalance
  };
}

async function findPostedBatchByIdempotencyKey(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  expectedRequestHash: string
) {
  const existing = await client.query<{
    id: string;
    work_order_id: string;
    status: string;
    consumption_movement_id: string | null;
    production_movement_id: string | null;
    quantity_completed: string | number | null;
    work_order_status: string;
    idempotency_request_hash: string | null;
  }>(
    `SELECT e.id,
            e.work_order_id,
            e.status,
            e.consumption_movement_id,
            e.production_movement_id,
            w.quantity_completed,
            w.status AS work_order_status,
            e.idempotency_request_hash
       FROM work_order_executions e
       JOIN work_orders w
         ON w.id = e.work_order_id
        AND w.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1
        AND e.idempotency_key = $2
      FOR UPDATE OF e`,
    [tenantId, idempotencyKey]
  );
  if (existing.rowCount === 0) {
    return null;
  }
  const row = existing.rows[0];
  if (!row.idempotency_request_hash) {
    throw domainError('WO_POSTING_IDEMPOTENCY_CONFLICT', {
      reason: 'missing_request_hash',
      executionId: row.id
    });
  }
  if (row.idempotency_request_hash !== expectedRequestHash) {
    throw domainError('WO_POSTING_IDEMPOTENCY_CONFLICT', {
      reason: 'request_hash_mismatch',
      executionId: row.id
    });
  }
  if (row.status !== 'posted') {
    throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
      reason: 'execution_not_posted',
      missingExecutionIds: [row.id],
      hint: 'Retry with the same Idempotency-Key or contact admin'
    });
  }
  if (!row.consumption_movement_id || !row.production_movement_id) {
    throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
      reason: 'missing_execution_movements',
      missingExecutionIds: [row.id],
      hint: 'Retry with the same Idempotency-Key or contact admin'
    });
  }
  try {
    await ensurePostedMovementReady(client, tenantId, row.consumption_movement_id);
    await ensurePostedMovementReady(client, tenantId, row.production_movement_id);
  } catch (error: any) {
    if (
      error?.message === 'WO_POSTING_MOVEMENT_MISSING' ||
      error?.message === 'WO_POSTING_IDEMPOTENCY_INCOMPLETE'
    ) {
      throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        reason: 'movement_not_ready',
        missingExecutionIds: [row.id],
        hint: 'Retry with the same Idempotency-Key or contact admin'
      });
    }
    throw error;
  }
  return {
    executionId: row.id,
    workOrderId: row.work_order_id,
    issueMovementId: row.consumption_movement_id,
    receiveMovementId: row.production_movement_id,
    quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
    workOrderStatus: row.work_order_status
  };
}

async function fetchWorkOrderById(
  tenantId: string,
  id: string,
  client?: PoolClient
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId
  ]);
  return result.rowCount === 0 ? null : result.rows[0];
}

function buildAutoOutputLotCode(workOrderNumber: string, executionId: string) {
  const normalizedOrder = workOrderNumber.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48) || 'WO';
  return `WO-${normalizedOrder}-${executionId.slice(0, 8).toUpperCase()}`;
}

async function resolveOrCreateOutputLot(
  client: PoolClient,
  params: {
    tenantId: string;
    outputItemId: string;
    outputLotId?: string | null;
    outputLotCode?: string | null;
    workOrderNumber: string;
    executionId: string;
    occurredAt: Date;
  }
): Promise<{ id: string; lotCode: string }> {
  const {
    tenantId,
    outputItemId,
    outputLotId,
    outputLotCode,
    workOrderNumber,
    executionId,
    occurredAt
  } = params;

  if (outputLotId) {
    const existing = await client.query<{ id: string; item_id: string; lot_code: string }>(
      `SELECT id, item_id, lot_code
         FROM lots
        WHERE id = $1
          AND tenant_id = $2`,
      [outputLotId, tenantId]
    );
    if (!existing.rows[0]) {
      throw new Error('WO_REPORT_OUTPUT_LOT_NOT_FOUND');
    }
    if (existing.rows[0].item_id !== outputItemId) {
      throw new Error('WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH');
    }
    return { id: existing.rows[0].id, lotCode: existing.rows[0].lot_code };
  }

  const lotCode = (outputLotCode?.trim() || buildAutoOutputLotCode(workOrderNumber, executionId)).slice(0, 120);
  const found = await client.query<{ id: string; lot_code: string }>(
    `SELECT id, lot_code
       FROM lots
      WHERE tenant_id = $1
        AND item_id = $2
        AND lot_code = $3
      LIMIT 1`,
    [tenantId, outputItemId, lotCode]
  );
  if (found.rows[0]) {
    return { id: found.rows[0].id, lotCode: found.rows[0].lot_code };
  }

  const now = new Date();
  const lotId = uuidv4();
  try {
    const inserted = await client.query<{ id: string; lot_code: string }>(
      `INSERT INTO lots (
         id, tenant_id, item_id, lot_code, status, manufactured_at, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $7)
       RETURNING id, lot_code`,
      [
        lotId,
        tenantId,
        outputItemId,
        lotCode,
        occurredAt,
        `Auto-created from report-production execution ${executionId}`,
        now
      ]
    );
    return { id: inserted.rows[0].id, lotCode: inserted.rows[0].lot_code };
  } catch (error: any) {
    if (error?.code === '23505') {
      const replayFound = await client.query<{ id: string; lot_code: string }>(
        `SELECT id, lot_code
           FROM lots
          WHERE tenant_id = $1
            AND item_id = $2
            AND lot_code = $3
          LIMIT 1`,
        [tenantId, outputItemId, lotCode]
      );
      if (replayFound.rows[0]) {
        return { id: replayFound.rows[0].id, lotCode: replayFound.rows[0].lot_code };
      }
    }
    throw error;
  }
}

export async function verifyWorkOrderWipIntegrityForClose(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
) {
  if (client) {
    await verifyWorkOrderWipIntegrity(client, tenantId, workOrderId);
    return;
  }
  await withTransaction(async (tx) => {
    await verifyWorkOrderWipIntegrity(tx, tenantId, workOrderId);
  });
}

async function persistWorkOrderLotLinks(
  tenantId: string,
  params: {
    executionId: string;
    outputItemId: string;
    outputQty: number;
    outputUom: string;
    outputLotId?: string;
    outputLotCode?: string;
    inputLots?: WorkOrderReportProductionInputLot[];
    workOrderNumber: string;
    occurredAt: Date;
  }
): Promise<{ outputLotId: string; outputLotCode: string; inputLotCount: number }> {
  const {
    executionId,
    outputItemId,
    outputQty,
    outputUom,
    outputLotId,
    outputLotCode,
    inputLots,
    workOrderNumber,
    occurredAt
  } = params;

  return withTransactionRetry(async (client) => {
    const executionRes = await client.query<{ id: string; production_movement_id: string | null }>(
      `SELECT id, production_movement_id
         FROM work_order_executions
        WHERE tenant_id = $1
          AND id = $2
        FOR UPDATE`,
      [tenantId, executionId]
    );
    if (!executionRes.rows[0]) {
      throw new Error('WO_REPORT_EXECUTION_NOT_FOUND');
    }
    const productionMovementId = executionRes.rows[0].production_movement_id;
    if (!productionMovementId) {
      throw new Error('WO_REPORT_EXECUTION_NOT_POSTED');
    }

    const resolvedOutputLot = await resolveOrCreateOutputLot(client, {
      tenantId,
      outputItemId,
      outputLotId: outputLotId ?? null,
      outputLotCode: outputLotCode ?? null,
      workOrderNumber,
      executionId,
      occurredAt
    });

    const now = new Date();
    await client.query(
      `INSERT INTO work_order_lot_links (
         id, tenant_id, work_order_execution_id, role, item_id, lot_id, uom, quantity, created_at
       ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, work_order_execution_id, role, item_id, lot_id, uom) DO NOTHING`,
      [
        uuidv4(),
        tenantId,
        executionId,
        outputItemId,
        resolvedOutputLot.id,
        outputUom,
        roundQuantity(outputQty),
        now
      ]
    );

    const producedLines = await client.query<{
      id: string;
      uom: string;
      quantity_delta: string | number;
    }>(
      `SELECT id, uom, quantity_delta
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND movement_id = $2
          AND item_id = $3
          AND quantity_delta > 0
        ORDER BY id`,
      [tenantId, productionMovementId, outputItemId]
    );
    if ((producedLines.rowCount ?? 0) === 0) {
      throw new Error('WO_REPORT_OUTPUT_MOVEMENT_LINES_MISSING');
    }
    for (const producedLine of producedLines.rows) {
      await client.query(
        `INSERT INTO inventory_movement_lots (
           id, tenant_id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, inventory_movement_line_id, lot_id) DO NOTHING`,
        [
          uuidv4(),
          tenantId,
          producedLine.id,
          resolvedOutputLot.id,
          producedLine.uom,
          roundQuantity(toNumber(producedLine.quantity_delta)),
          now
        ]
      );
    }

    const normalizedInputLots = Array.isArray(inputLots) ? inputLots : [];
    if (normalizedInputLots.length > 0) {
      const lotIds = Array.from(new Set(normalizedInputLots.map((lot) => lot.lotId)));
      const lotRows = await client.query<{ id: string; item_id: string }>(
        `SELECT id, item_id
           FROM lots
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])`,
        [tenantId, lotIds]
      );
      const byId = new Map(lotRows.rows.map((row) => [row.id, row]));
      for (const inputLot of normalizedInputLots) {
        const lotRow = byId.get(inputLot.lotId);
        if (!lotRow) {
          throw new Error('WO_REPORT_INPUT_LOT_NOT_FOUND');
        }
        if (lotRow.item_id !== inputLot.componentItemId) {
          throw new Error('WO_REPORT_INPUT_LOT_ITEM_MISMATCH');
        }
      }

      for (const inputLot of normalizedInputLots) {
        await client.query(
          `INSERT INTO work_order_lot_links (
             id, tenant_id, work_order_execution_id, role, item_id, lot_id, uom, quantity, created_at
           ) VALUES ($1, $2, $3, 'consume', $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, work_order_execution_id, role, item_id, lot_id, uom) DO NOTHING`,
          [
            uuidv4(),
            tenantId,
            executionId,
            inputLot.componentItemId,
            inputLot.lotId,
            inputLot.uom,
            roundQuantity(toNumber(inputLot.quantity)),
            now
          ]
        );
      }
    }

    return {
      outputLotId: resolvedOutputLot.id,
      outputLotCode: resolvedOutputLot.lotCode,
      inputLotCount: normalizedInputLots.length
    };
  });
}

async function allocateWipCostFromMovement(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  movementId: string,
  allocatedAt: Date
): Promise<number> {
  const rows = await client.query<{ id: string; extended_cost: string | number }>(
    `SELECT id, extended_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'production_input'
        AND wip_execution_id IS NULL
      FOR UPDATE`,
    [tenantId, movementId]
  );

  if (rows.rowCount === 0) {
    throw new Error('WO_WIP_COST_NO_CONSUMPTIONS');
  }

  const ids = rows.rows.map((row) => row.id);
  const totalCost = rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0);

  await client.query(
    `UPDATE cost_layer_consumptions
        SET wip_execution_id = $1,
            wip_allocated_at = $2
      WHERE tenant_id = $3
        AND id = ANY($4::uuid[])`,
    [executionId, allocatedAt, tenantId, ids]
  );

  return totalCost;
}

type PendingWipCostAllocation = {
  consumptionIds: string[];
  totalCost: number;
};

async function lockUnallocatedWipCostFromMovement(
  client: PoolClient,
  tenantId: string,
  movementId: string
): Promise<PendingWipCostAllocation> {
  const rows = await client.query<{ id: string; extended_cost: string | number }>(
    `SELECT id, extended_cost
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND movement_id = $2
        AND consumption_type = 'production_input'
        AND wip_execution_id IS NULL
      FOR UPDATE`,
    [tenantId, movementId]
  );

  if (rows.rowCount === 0) {
    throw new Error('WO_WIP_COST_NO_CONSUMPTIONS');
  }

  return {
    consumptionIds: rows.rows.map((row) => row.id),
    totalCost: rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0)
  };
}

async function lockUnallocatedWipCostFromWorkOrderIssues(
  client: PoolClient,
  tenantId: string,
  workOrderId: string
): Promise<PendingWipCostAllocation> {
  const rows = await client.query<{ id: string; extended_cost: string | number }>(
    `SELECT clc.id, clc.extended_cost
       FROM cost_layer_consumptions clc
       JOIN work_order_material_issues wmi
         ON wmi.id = clc.consumption_document_id
        AND wmi.tenant_id = clc.tenant_id
      WHERE wmi.work_order_id = $1
        AND wmi.status = 'posted'
        AND clc.tenant_id = $2
        AND clc.consumption_type = 'production_input'
        AND clc.wip_execution_id IS NULL
      FOR UPDATE OF clc`,
    [workOrderId, tenantId]
  );

  if (rows.rowCount === 0) {
    throw new Error('WO_WIP_COST_NO_CONSUMPTIONS');
  }

  return {
    consumptionIds: rows.rows.map((row) => row.id),
    totalCost: rows.rows.reduce((sum, row) => sum + toNumber(row.extended_cost), 0)
  };
}

async function applyWipCostAllocation(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  allocatedAt: Date,
  pending: PendingWipCostAllocation
): Promise<number> {
  await client.query(
    `UPDATE cost_layer_consumptions
        SET wip_execution_id = $1,
            wip_allocated_at = $2
      WHERE tenant_id = $3
        AND id = ANY($4::uuid[])`,
    [executionId, allocatedAt, tenantId, pending.consumptionIds]
  );
  return pending.totalCost;
}

async function allocateWipCostFromWorkOrderIssues(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  executionId: string,
  allocatedAt: Date
): Promise<number> {
  return applyWipCostAllocation(
    client,
    tenantId,
    executionId,
    allocatedAt,
    await lockUnallocatedWipCostFromWorkOrderIssues(client, tenantId, workOrderId)
  );
}

export async function createWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderIssueCreateInput,
  options?: { idempotencyKey?: string | null }
) {
  const lineNumbers = new Set<number>();
  const normalizedLines = data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('WO_ISSUE_DUPLICATE_LINE');
    }
    const quantityIssued = toNumber(line.quantityIssued);
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: line.uom,
      quantityIssued,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });

  const issueId = uuidv4();
  const now = new Date();
  const idempotencyKey = options?.idempotencyKey ?? null;

  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM work_order_material_issues WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (existing.rowCount > 0) {
        return fetchWorkOrderIssue(tenantId, workOrderId, existing.rows[0].id, client);
      }
    }
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new Error('WO_INVALID_STATE');
    }

    if (workOrder.kind !== 'disassembly') {
      for (const line of normalizedLines) {
        await assertWorkOrderRoutingLine({
          tenantId,
          context: workOrderRoutingContext(workOrder),
          componentItemId: line.componentItemId,
          consumeLocationId: line.fromLocationId,
          client
        });
      }
    }

    await client.query(
      `INSERT INTO work_order_material_issues (
          id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, $3, 'draft', $4, NULL, $5, $6, $7, $7)`,
      [issueId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, idempotencyKey, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_material_issue_lines (
            id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          issueId,
          line.lineNumber,
          line.componentItemId,
          line.uom,
          line.quantityIssued,
          line.fromLocationId,
          line.reasonCode,
          line.notes,
          now
        ]
      );
    }

    const issue = await fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    if (!issue) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_CREATE');
    }
    return issue;
  });
}

export async function fetchWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  issueId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const headerResult = await executor<WorkOrderMaterialIssueRow>(
    'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3',
    [issueId, workOrderId, tenantId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderMaterialIssueLineRow>(
    'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [issueId, tenantId]
  );
  return mapMaterialIssue(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderIssue(
  tenantId: string,
  workOrderId: string,
  issueId: string,
  context: NegativeOverrideContext = {}
) {
  let workOrder: WorkOrderRow | null = null;
  let issue: WorkOrderMaterialIssueRow | null = null;
  let issueState: ManufacturingMutationState | null = null;
  let linesForPosting: WorkOrderMaterialIssueLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<any>({
    tenantId,
    endpoint: 'wo.issue.post',
    operation: 'work_order_issue_post',
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    lockTargets: async (client) => {
      workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      if (isTerminalWorkOrderStatus(workOrder.status)) {
        throw new Error('WO_INVALID_STATE');
      }

      const issueResult = await client.query<WorkOrderMaterialIssueRow>(
        `SELECT *
           FROM work_order_material_issues
          WHERE id = $1
            AND work_order_id = $2
            AND tenant_id = $3
          FOR UPDATE`,
        [issueId, workOrderId, tenantId]
      );
      if (issueResult.rowCount === 0) {
        throw new Error('WO_ISSUE_NOT_FOUND');
      }
      issue = issueResult.rows[0];
      if (issue.status === 'canceled') {
        throw new Error('WO_ISSUE_CANCELED');
      }
      issueState = deriveIssueMutationState(issue);
      if (issueState === 'posted_issue') {
        if (!issue.inventory_movement_id) {
          throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
            flow: 'issue',
            issueId,
            reason: 'posted_issue_missing_authoritative_movement'
          });
        }
        return [];
      }

      const linesResult = await client.query<WorkOrderMaterialIssueLineRow>(
        `SELECT *
           FROM work_order_material_issue_lines
          WHERE work_order_material_issue_id = $1
            AND tenant_id = $2
          ORDER BY line_number ASC`,
        [issueId, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('WO_ISSUE_NO_LINES');
      }
      linesForPosting = [...linesResult.rows].sort(compareIssueLineLockKey);
      warehouseIdsByLocation = new Map<string, string>();
      for (const line of linesForPosting) {
        if (!warehouseIdsByLocation.has(line.from_location_id)) {
          warehouseIdsByLocation.set(
            line.from_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.from_location_id, client)
          );
        }
      }
      return linesForPosting.map((line) => ({
        tenantId,
        warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
        itemId: line.component_item_id
      }));
    },
    execute: async ({ client }) => {
      if (!workOrder || !issue || !issueState) {
        throw new Error('WO_ISSUE_NOT_FOUND');
      }

      const isDisassembly = workOrder.kind === 'disassembly';
      const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
      const issuedTotal = linesForPosting.reduce(
        (sum, line) => sum + toNumber(line.quantity_issued),
        0
      );
      const preparedLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: WorkOrderMaterialIssueLineRow;
        canonicalFields: CanonicalMovementFields;
        reasonCode: string;
      }> = [];
      for (const line of linesForPosting) {
        if (isDisassembly && line.component_item_id !== workOrder.output_item_id) {
          throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
        }
        const qty = toNumber(line.quantity_issued);
        if (qty <= 0) {
          throw new Error('WO_ISSUE_INVALID_QUANTITY');
        }
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.component_item_id,
          -qty,
          line.uom,
          client
        );
        preparedLines.push({
          sourceLineId: line.id,
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          line,
          canonicalFields,
          reasonCode: line.reason_code ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue')
        });
      }

      const sortedMovementLines = sortDeterministicMovementLines(preparedLines, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.from_location_id,
        itemId: entry.line.component_item_id,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));
      if (issueState === 'posted_issue') {
        return buildWorkOrderIssueReplayResult({
          tenantId,
          workOrderId,
          issueId,
          movementId: issue.inventory_movement_id!,
          expectedLineCount: sortedMovementLines.length,
          client
        });
      }

      assertManufacturingTransition({
        flow: 'issue',
        currentState: issueState,
        allowedFrom: ['planned_issue'],
        targetState: 'posted_issue',
        workOrderId,
        executionOrDocumentId: issueId
      });

      const now = new Date();
      const occurredAt = new Date(issue.occurred_at);
      const validation = await validateSufficientStock(
        tenantId,
        occurredAt,
        linesForPosting.map((line) => ({
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          itemId: line.component_item_id,
          locationId: line.from_location_id,
          uom: line.uom,
          quantityToConsume: roundQuantity(toNumber(line.quantity_issued))
        })),
        {
          actorId: context.actor?.id ?? null,
          actorRole: context.actor?.role ?? null,
          overrideRequested: context.overrideRequested,
          overrideReason: context.overrideReason ?? null,
          overrideReference: `work_order_issue:${issueId}`
        },
        { client }
      );

      const movementId = uuidv4();
      const plannedMovementLines: Array<{
        preparedLine: (typeof sortedMovementLines)[number];
        issueCost: number | null;
        consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
      }> = [];
      for (const preparedLine of sortedMovementLines) {
        const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
        let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
        try {
          consumptionPlan = await planCostLayerConsumption({
            tenant_id: tenantId,
            item_id: preparedLine.line.component_item_id,
            location_id: preparedLine.line.from_location_id,
            quantity: canonicalQty,
            consumption_type: 'production_input',
            consumption_document_id: issueId,
            movement_id: movementId,
            client
          });
        } catch {
          throw new Error('WO_WIP_COST_LAYERS_MISSING');
        }
        plannedMovementLines.push({
          preparedLine,
          issueCost: consumptionPlan.total_cost,
          consumptionPlan
        });
      }

      const movement = await persistInventoryMovement(client, {
        id: movementId,
        tenantId,
        movementType: 'issue',
        status: 'posted',
        externalRef: isDisassembly
          ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
          : `work_order_issue:${issueId}:${workOrderId}`,
        sourceType: 'work_order_issue_post',
        sourceId: issueId,
        idempotencyKey: `wo-issue-post:${issueId}`,
        occurredAt,
        postedAt: now,
        notes: issue.notes ?? null,
        metadata: {
          workOrderId,
          workOrderNumber,
          ...(validation.overrideMetadata ?? {})
        },
        createdAt: now,
        updatedAt: now,
        lines: plannedMovementLines.map(({ preparedLine, issueCost }) => {
          const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
          const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
          const extendedCost = issueCost !== null ? -issueCost : null;
          return {
            warehouseId: preparedLine.warehouseId,
            sourceLineId: preparedLine.sourceLineId,
            itemId: preparedLine.line.component_item_id,
            locationId: preparedLine.line.from_location_id,
            quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
            uom: preparedLine.canonicalFields.canonicalUom,
            quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
            uomEntered: preparedLine.canonicalFields.uomEntered,
            quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
            canonicalUom: preparedLine.canonicalFields.canonicalUom,
            uomDimension: preparedLine.canonicalFields.uomDimension,
            unitCost,
            extendedCost,
            reasonCode: preparedLine.reasonCode,
            lineNotes:
              preparedLine.line.notes ?? `Work order issue ${issueId} line ${preparedLine.line.line_number}`,
            createdAt: now
          };
        })
      });

      if (!movement.created) {
        return buildWorkOrderIssueReplayResult({
          tenantId,
          workOrderId,
          issueId,
          movementId: movement.movementId,
          expectedLineCount: sortedMovementLines.length,
          client
        });
      }

      let totalIssueCost = 0;
      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const { preparedLine, issueCost, consumptionPlan } of plannedMovementLines) {
        const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: preparedLine.line.component_item_id,
          location_id: preparedLine.line.from_location_id,
          quantity: canonicalQty,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: movement.movementId,
          client,
          plan: consumptionPlan
        });
        totalIssueCost += issueCost ?? 0;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedLine.line.component_item_id,
            locationId: preparedLine.line.from_location_id,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: null,
        movementId: movement.movementId,
        valuationType: 'issue',
        valueDelta: totalIssueCost,
        notes: `Work-order issue WIP valuation for issue ${issueId}`
      });

      projectionOps.push(async (projectionClient) => {
        await projectionClient.query(
          `UPDATE work_order_material_issues
              SET status = 'posted',
                  inventory_movement_id = $1,
                  updated_at = $2
            WHERE id = $3
              AND tenant_id = $4`,
          [movement.movementId, now, issueId, tenantId]
        );

        if (normalizeWorkOrderStatus(workOrder!.status) === 'draft' || normalizeWorkOrderStatus(workOrder!.status) === 'ready') {
          await projectionClient.query(
            `UPDATE work_orders
                SET status = $2,
                    updated_at = $3
              WHERE id = $1
                AND tenant_id = $4`,
            [workOrderId, nextStatusAfterExecutionStart(workOrder!.status), now, tenantId]
          );
        }

        if (isDisassembly) {
          const currentCompleted = toNumber(workOrder!.quantity_completed ?? 0);
          const newCompleted = currentCompleted + issuedTotal;
          const planned = toNumber(workOrder!.quantity_planned);
          const completedAt = newCompleted >= planned ? now : null;
          const nextStatus = nextStatusFromProgress({
            currentStatus: workOrder!.status,
            plannedQuantity: planned,
            completedQuantity: newCompleted
          });
          await projectionClient.query(
            `UPDATE work_orders
                SET quantity_completed = $2,
                    status = $3,
                    completed_at = COALESCE(completed_at, $4),
                    updated_at = $5
              WHERE id = $1
                AND tenant_id = $6`,
            [workOrderId, newCompleted, nextStatus, completedAt, now, tenantId]
          );
        }

        if (validation.overrideMetadata && context.actor) {
          await recordAuditLog(
            {
              tenantId,
              actorType: context.actor.type,
              actorId: context.actor.id ?? null,
              action: 'negative_override',
              entityType: 'inventory_movement',
              entityId: movement.movementId,
              occurredAt: now,
              metadata: {
                reason: validation.overrideMetadata.override_reason ?? null,
                workOrderId,
                issueId,
                reference: validation.overrideMetadata.override_reference ?? null,
                lines: linesForPosting.map((line) => ({
                  itemId: line.component_item_id,
                  locationId: line.from_location_id,
                  uom: line.uom,
                  quantity: roundQuantity(toNumber(line.quantity_issued))
                }))
              }
            },
            projectionClient
          );
        }
      });

      return {
        responseBody: mapMaterialIssue(
          {
            ...issue,
            status: 'posted',
            inventory_movement_id: movement.movementId,
            updated_at: now.toISOString()
          },
          linesForPosting
        ),
        responseStatus: 200,
        events: [
          buildMovementPostedEvent(movement.movementId),
          buildWorkOrderIssuePostedEvent({
            issueId,
            workOrderId,
            movementId: movement.movementId
          })
        ],
        projectionOps
      };
    }
  });
}

export async function createWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderCompletionCreateInput,
  options?: { idempotencyKey?: string | null }
) {
  const executionId = uuidv4();
  const now = new Date();
  const idempotencyKey = options?.idempotencyKey ?? null;
  const normalizedLines = data.lines.map((line) => ({
    ...line,
    uom: line.uom,
    quantityCompleted: toNumber(line.quantityCompleted)
  }));

  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM work_order_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (existing.rowCount > 0) {
        return fetchWorkOrderCompletion(tenantId, workOrderId, existing.rows[0].id, client);
      }
    }
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new Error('WO_INVALID_STATE');
    }

    if (workOrder.kind !== 'disassembly') {
      for (const line of normalizedLines) {
        await assertWorkOrderRoutingLine({
          tenantId,
          context: workOrderRoutingContext(workOrder),
          produceLocationId: line.toLocationId,
          client
        });
      }
    }

    await client.query(
      `INSERT INTO work_order_executions (
          id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id, notes, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, 'draft', NULL, NULL, $5, $6, $7)`,
      [executionId, tenantId, workOrderId, new Date(data.occurredAt), data.notes ?? null, idempotencyKey, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO work_order_execution_lines (
            id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
         ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
        [
          uuidv4(),
          tenantId,
          executionId,
          line.outputItemId,
          line.uom,
          line.quantityCompleted,
          line.packSize ?? null,
          line.toLocationId,
          line.reasonCode ?? null,
          line.notes ?? null,
          now
        ]
      );
    }

    const created = await fetchWorkOrderCompletion(tenantId, workOrderId, executionId, client);
    if (!created) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_CREATE');
    }
    return created;
  });
}

export async function fetchWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string,
  client?: PoolClient
) {
  const executor = client ? client.query.bind(client) : query;
  const headerResult = await executor<WorkOrderExecutionRow>(
    'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3',
    [completionId, workOrderId, tenantId]
  );
  if (headerResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<WorkOrderExecutionLineRow>(
    'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [completionId, tenantId]
  );
  return mapExecution(headerResult.rows[0], linesResult.rows);
}

export async function postWorkOrderCompletion(
  tenantId: string,
  workOrderId: string,
  completionId: string
) {
  let workOrder: WorkOrderRow | null = null;
  let execution: WorkOrderExecutionRow | null = null;
  let completionState: ManufacturingMutationState | null = null;
  let linesForPosting: WorkOrderExecutionLineRow[] = [];
  let warehouseIdsByLocation = new Map<string, string>();

  return runInventoryCommand<any>({
    tenantId,
    endpoint: 'wo.completion.post',
    operation: 'work_order_completion_post',
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    lockTargets: async (client) => {
      workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      if (isTerminalWorkOrderStatus(workOrder.status)) {
        throw new Error('WO_INVALID_STATE');
      }

      const execResult = await client.query<WorkOrderExecutionRow>(
        `SELECT *
           FROM work_order_executions
          WHERE id = $1
            AND work_order_id = $2
            AND tenant_id = $3
          FOR UPDATE`,
        [completionId, workOrderId, tenantId]
      );
      if (execResult.rowCount === 0) {
        throw new Error('WO_COMPLETION_NOT_FOUND');
      }
      execution = execResult.rows[0];
      if (execution.status === 'canceled') {
        throw new Error('WO_COMPLETION_CANCELED');
      }
      completionState = deriveCompletionMutationState({
        execution,
        flow: 'completion'
      });
      if (completionState === 'posted_completion') {
        if (!execution.production_movement_id) {
          throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
            flow: 'completion',
            completionId,
            reason: 'posted_completion_missing_authoritative_movement'
          });
        }
        return [];
      }

      const linesResult = await client.query<WorkOrderExecutionLineRow>(
        `SELECT *
           FROM work_order_execution_lines
          WHERE work_order_execution_id = $1
            AND tenant_id = $2
          ORDER BY created_at ASC`,
        [completionId, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('WO_COMPLETION_NO_LINES');
      }
      linesForPosting = [...linesResult.rows].sort(compareProduceLineLockKey);
      const isDisassembly = workOrder.kind === 'disassembly';
      warehouseIdsByLocation = new Map<string, string>();
      for (const line of linesForPosting) {
        if (line.line_type !== 'produce') {
          throw new Error('WO_COMPLETION_INVALID_LINE_TYPE');
        }
        if (!isDisassembly && line.item_id !== workOrder.output_item_id) {
          throw new Error('WO_COMPLETION_ITEM_MISMATCH');
        }
        if (!line.to_location_id) {
          throw new Error('WO_COMPLETION_LOCATION_REQUIRED');
        }
        const qty = toNumber(line.quantity);
        if (qty <= 0) {
          throw new Error('WO_COMPLETION_INVALID_QUANTITY');
        }
        if (!warehouseIdsByLocation.has(line.to_location_id)) {
          warehouseIdsByLocation.set(
            line.to_location_id,
            await resolveWarehouseIdForLocation(tenantId, line.to_location_id, client)
          );
        }
      }
      return linesForPosting.map((line) => ({
        tenantId,
        warehouseId: warehouseIdsByLocation.get(line.to_location_id!) ?? '',
        itemId: line.item_id
      }));
    },
    execute: async ({ client }) => {
      if (!workOrder || !execution || !completionState) {
        throw new Error('WO_COMPLETION_NOT_FOUND');
      }
      const isDisassembly = workOrder.kind === 'disassembly';
      const preparedLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: WorkOrderExecutionLineRow;
        canonicalFields: CanonicalMovementFields;
        reasonCode: string;
      }> = [];
      let totalProduced = 0;
      let totalProducedCanonical = 0;
      for (const line of linesForPosting) {
        const qty = toNumber(line.quantity);
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          qty,
          line.uom,
          client
        );
        totalProduced += qty;
        totalProducedCanonical += canonicalFields.quantityDeltaCanonical;
        preparedLines.push({
          sourceLineId: line.id,
          warehouseId: warehouseIdsByLocation.get(line.to_location_id!) ?? '',
          line,
          canonicalFields,
          reasonCode: line.reason_code ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion')
        });
      }

      const sortedMovementLines = sortDeterministicMovementLines(preparedLines, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.to_location_id!,
        itemId: entry.line.item_id,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));
      if (completionState === 'posted_completion') {
        return buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: execution.production_movement_id!,
          expectedLineCount: sortedMovementLines.length,
          client
        });
      }

      assertManufacturingTransition({
        flow: 'completion',
        currentState: completionState,
        allowedFrom: ['planned_completion'],
        targetState: 'posted_completion',
        workOrderId,
        executionOrDocumentId: completionId
      });

      const now = new Date();
      if (totalProducedCanonical <= 0) {
        throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
      }
      const pendingWipAllocation = await lockUnallocatedWipCostFromWorkOrderIssues(
        client,
        tenantId,
        workOrderId
      );
      const totalIssueCost = pendingWipAllocation.totalCost;
      const plannedMovementLines = sortedMovementLines.map((preparedLine) => {
        const allocationRatio = preparedLine.canonicalFields.quantityDeltaCanonical / totalProducedCanonical;
        const allocatedCost = totalIssueCost * allocationRatio;
        const unitCost =
          preparedLine.canonicalFields.quantityDeltaCanonical !== 0
            ? allocatedCost / preparedLine.canonicalFields.quantityDeltaCanonical
            : null;
        return {
          preparedLine,
          allocatedCost,
          unitCost
        };
      });
      const movementId = uuidv4();
      const movement = await persistInventoryMovement(client, {
        id: movementId,
        tenantId,
        movementType: 'receive',
        status: 'posted',
        externalRef: isDisassembly
          ? `work_order_disassembly_completion:${completionId}:${workOrderId}`
          : `work_order_completion:${completionId}:${workOrderId}`,
        sourceType: 'work_order_completion_post',
        sourceId: completionId,
        idempotencyKey: `wo-completion-post:${completionId}`,
        occurredAt: execution.occurred_at,
        postedAt: now,
        notes: execution.notes ?? null,
        metadata: {
          workOrderId,
          workOrderNumber: workOrder.number ?? workOrder.work_order_number
        },
        createdAt: now,
        updatedAt: now,
        lines: plannedMovementLines.map(({ preparedLine, allocatedCost, unitCost }) => ({
          warehouseId: preparedLine.warehouseId,
          sourceLineId: preparedLine.sourceLineId,
          itemId: preparedLine.line.item_id,
          locationId: preparedLine.line.to_location_id!,
          quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedLine.canonicalFields.canonicalUom,
          uomDimension: preparedLine.canonicalFields.uomDimension,
          unitCost,
          extendedCost: allocatedCost,
          reasonCode: preparedLine.reasonCode,
          lineNotes: preparedLine.line.notes ?? `Work order completion ${completionId}`,
          createdAt: now
        }))
      });

      if (!movement.created) {
        return buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: movement.movementId,
          expectedLineCount: sortedMovementLines.length,
          client
        });
      }
      const wipUnitCostCanonical = totalIssueCost / totalProducedCanonical;

      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const { preparedLine, allocatedCost, unitCost } of plannedMovementLines) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedLine.line.item_id,
          location_id: preparedLine.line.to_location_id!,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantity: preparedLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost ?? 0,
          source_type: 'production',
          source_document_id: completionId,
          movement_id: movement.movementId,
          notes: `Production output from work order ${workOrderId}`,
          client
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedLine.line.item_id,
            locationId: preparedLine.line.to_location_id!,
            uom: preparedLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }
      await applyWipCostAllocation(client, tenantId, completionId, now, pendingWipAllocation);

      const completionUomSet = new Set(
        sortedMovementLines.map((line) => line.canonicalFields.canonicalUom)
      );
      const completionCanonicalUom =
        completionUomSet.size === 1 ? sortedMovementLines[0]?.canonicalFields.canonicalUom ?? null : null;
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: completionId,
        movementId: movement.movementId,
        valuationType: 'completion',
        valueDelta: -totalIssueCost,
        quantityCanonical: completionCanonicalUom ? totalProducedCanonical : null,
        canonicalUom: completionCanonicalUom,
        notes: `Work-order completion WIP capitalization for execution ${completionId}`
      });
      await verifyWorkOrderWipIntegrity(client, tenantId, workOrderId);

      projectionOps.push(async (projectionClient) => {
        await projectionClient.query(
          `UPDATE work_order_executions
              SET status = 'posted',
                  production_movement_id = $1,
                  wip_total_cost = $2,
                  wip_unit_cost = $3,
                  wip_quantity_canonical = $4,
                  wip_cost_method = $5,
                  wip_costed_at = $6
            WHERE id = $7
              AND tenant_id = $8`,
          [
            movement.movementId,
            totalIssueCost,
            wipUnitCostCanonical,
            totalProducedCanonical,
            WIP_COST_METHOD,
            now,
            completionId,
            tenantId
          ]
        );

        if (!isDisassembly) {
          const currentCompleted = toNumber(workOrder!.quantity_completed ?? 0);
          const newCompleted = currentCompleted + totalProduced;
          const planned = toNumber(workOrder!.quantity_planned);
          const completedAt = newCompleted >= planned ? now : null;
          const newStatus = nextStatusFromProgress({
            currentStatus: workOrder!.status,
            plannedQuantity: planned,
            completedQuantity: newCompleted
          });
          await projectionClient.query(
            `UPDATE work_orders
                SET quantity_completed = $2,
                    status = $3,
                    completed_at = COALESCE(completed_at, $4),
                    wip_total_cost = COALESCE(wip_total_cost, 0) + $5,
                    wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $6,
                    wip_unit_cost = CASE
                      WHEN (COALESCE(wip_quantity_canonical, 0) + $6) > 0
                      THEN (COALESCE(wip_total_cost, 0) + $5) / (COALESCE(wip_quantity_canonical, 0) + $6)
                      ELSE NULL
                    END,
                    wip_cost_method = $7,
                    wip_costed_at = $8,
                    updated_at = $9
              WHERE id = $1
                AND tenant_id = $10`,
            [
              workOrderId,
              newCompleted,
              newStatus,
              completedAt,
              totalIssueCost,
              totalProducedCanonical,
              WIP_COST_METHOD,
              now,
              now,
              tenantId
            ]
          );
        } else if (
          normalizeWorkOrderStatus(workOrder!.status) === 'draft'
          || normalizeWorkOrderStatus(workOrder!.status) === 'ready'
        ) {
          await projectionClient.query(
            `UPDATE work_orders
                SET status = $2,
                    wip_total_cost = COALESCE(wip_total_cost, 0) + $3,
                    wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $4,
                    wip_unit_cost = CASE
                      WHEN (COALESCE(wip_quantity_canonical, 0) + $4) > 0
                      THEN (COALESCE(wip_total_cost, 0) + $3) / (COALESCE(wip_quantity_canonical, 0) + $4)
                      ELSE NULL
                    END,
                    wip_cost_method = $5,
                    wip_costed_at = $6,
                    updated_at = $7
              WHERE id = $1
                AND tenant_id = $8`,
            [
              workOrderId,
              nextStatusAfterExecutionStart(workOrder!.status),
              totalIssueCost,
              totalProducedCanonical,
              WIP_COST_METHOD,
              now,
              now,
              tenantId
            ]
          );
        } else {
          await projectionClient.query(
            `UPDATE work_orders
                SET wip_total_cost = COALESCE(wip_total_cost, 0) + $2,
                    wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $3,
                    wip_unit_cost = CASE
                      WHEN (COALESCE(wip_quantity_canonical, 0) + $3) > 0
                      THEN (COALESCE(wip_total_cost, 0) + $2) / (COALESCE(wip_quantity_canonical, 0) + $3)
                      ELSE NULL
                    END,
                    wip_cost_method = $4,
                    wip_costed_at = $5,
                    updated_at = $6
              WHERE id = $1
                AND tenant_id = $7`,
            [
              workOrderId,
              totalIssueCost,
              totalProducedCanonical,
              WIP_COST_METHOD,
              now,
              now,
              tenantId
            ]
          );
        }
      });

      return {
        responseBody: mapExecution(
          {
            ...execution,
            status: 'posted',
            production_movement_id: movement.movementId,
            wip_total_cost: totalIssueCost,
            wip_unit_cost: wipUnitCostCanonical,
            wip_quantity_canonical: totalProducedCanonical,
            wip_cost_method: WIP_COST_METHOD,
            wip_costed_at: now.toISOString()
          },
          linesForPosting
        ),
        responseStatus: 200,
        events: [
          buildMovementPostedEvent(movement.movementId),
          buildWorkOrderCompletionPostedEvent({
            executionId: completionId,
            workOrderId,
            movementId: movement.movementId
          })
        ],
        projectionOps
      };
    }
  });
}

export async function getWorkOrderExecutionSummary(tenantId: string, workOrderId: string) {
  const workOrderResult = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    workOrderId,
    tenantId
  ]);
  if (workOrderResult.rowCount === 0) {
    return null;
  }
  const workOrder = workOrderResult.rows[0];

  const issuedRows = await query(
    `SELECT l.component_item_id,
            i.sku AS component_item_sku,
            i.name AS component_item_name,
            l.uom,
            SUM(l.quantity_issued) AS qty
       FROM work_order_material_issue_lines l
       JOIN work_order_material_issues h ON h.id = l.work_order_material_issue_id
       JOIN items i ON i.id = l.component_item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.component_item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const producedRows = await query(
    `SELECT l.item_id,
            i.sku AS item_sku,
            i.name AS item_name,
            l.uom,
            SUM(l.quantity) AS qty
       FROM work_order_execution_lines l
       JOIN work_order_executions h ON h.id = l.work_order_execution_id
       JOIN items i ON i.id = l.item_id AND i.tenant_id = h.tenant_id
      WHERE h.work_order_id = $1
        AND h.status = 'posted'
        AND l.line_type = 'produce'
        AND h.tenant_id = $2
        AND l.tenant_id = $2
      GROUP BY l.item_id, i.sku, i.name, l.uom`,
    [workOrderId, tenantId]
  );

  const planned = roundQuantity(toNumber(workOrder.quantity_planned));
  const completed = roundQuantity(toNumber(workOrder.quantity_completed ?? 0));
  const scrapped = roundQuantity(toNumber(workOrder.quantity_scrapped ?? 0));

  const bom = workOrder.bom_id ? await fetchBomById(tenantId, workOrder.bom_id) : null;

  return {
    workOrder: {
      id: workOrder.id,
      status: workOrder.status,
      kind: workOrder.kind,
      bomId: workOrder.bom_id,
      bomVersionId: workOrder.bom_version_id,
      outputItemId: workOrder.output_item_id,
      outputUom: workOrder.output_uom,
      quantityPlanned: planned,
      quantityCompleted: completed,
      quantityScrapped: scrapped,
      completedAt: workOrder.completed_at
    },
    issuedTotals: issuedRows.rows.map((row: any) => ({
      componentItemId: row.component_item_id,
      componentItemSku: row.component_item_sku,
      componentItemName: row.component_item_name,
      uom: row.uom,
      quantityIssued: roundQuantity(toNumber(row.qty))
    })),
    completedTotals: producedRows.rows.map((row: any) => ({
      outputItemId: row.item_id,
      outputItemSku: row.item_sku,
      outputItemName: row.item_name,
      uom: row.uom,
      quantityCompleted: roundQuantity(toNumber(row.qty))
    })),
    remainingToComplete: roundQuantity(Math.max(0, planned - completed - scrapped)),
    bom
  };
}

export type WorkOrderProductionReportResult = {
  workOrderId: string;
  productionReportId: string;
  componentIssueMovementId: string;
  productionReceiptMovementId: string;
  idempotencyKey: string | null;
  replayed: boolean;
  lotTracking?: {
    outputLotId: string;
    outputLotCode: string;
    inputLotCount: number;
  };
};

export type WorkOrderVoidReportResult = {
  workOrderId: string;
  workOrderExecutionId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

export type WorkOrderScrapReportResult = {
  workOrderId: string;
  workOrderExecutionId: string;
  scrapMovementId: string;
  itemId: string;
  quantity: number;
  uom: string;
  idempotencyKey: string | null;
  replayed: boolean;
};

const WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE = 'work_order_batch_void_output';
const WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE = 'work_order_batch_void_components';
const WORK_ORDER_SCRAP_SOURCE_TYPE = 'work_order_scrap';

type LockedExecutionRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
};

type MovementLineScopeRow = {
  item_id: string;
  location_id: string;
  warehouse_id: string | null;
  qty_canonical: string | number;
  balance_uom: string;
  unit_cost: string | number | null;
  extended_cost: string | number | null;
};

type ExistingVoidMovementsRow = {
  id: string;
  source_type: string;
  status: string;
};

function normalizedOptionalIdempotencyKey(key?: string | null) {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveReportProductionIdempotencyKey(
  workOrderId: string,
  data: WorkOrderReportProductionInput,
  options?: { idempotencyKey?: string | null }
) {
  const explicit = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  if (explicit) {
    return explicit;
  }
  const clientRequestId = normalizedOptionalIdempotencyKey(data.clientRequestId ?? null);
  if (!clientRequestId) {
    return null;
  }
  return `wo-report:${workOrderId}:${clientRequestId}`;
}

function shouldSimulateLotLinkFailureOnce(idempotencyKey: string | null, replayed: boolean) {
  if (replayed || !idempotencyKey) return false;
  // Guarded by an explicit test-only key marker to avoid env-coupled flakiness.
  if (!idempotencyKey.includes(':simulate-lot-link-failure')) return false;
  if (FORCED_LOT_LINK_FAILURE_KEYS.has(idempotencyKey)) return false;
  FORCED_LOT_LINK_FAILURE_KEYS.add(idempotencyKey);
  return true;
}

function isNonRetryableLotLinkError(error: any) {
  const code = error?.code;
  const message = error?.message;
  return (
    code === 'WO_REPORT_OUTPUT_LOT_NOT_FOUND' ||
    message === 'WO_REPORT_OUTPUT_LOT_NOT_FOUND' ||
    code === 'WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH' ||
    message === 'WO_REPORT_OUTPUT_LOT_ITEM_MISMATCH' ||
    code === 'WO_REPORT_INPUT_LOT_NOT_FOUND' ||
    message === 'WO_REPORT_INPUT_LOT_NOT_FOUND' ||
    code === 'WO_REPORT_INPUT_LOT_ITEM_MISMATCH' ||
    message === 'WO_REPORT_INPUT_LOT_ITEM_MISMATCH'
  );
}

function assertVoidReason(reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('WO_VOID_REASON_REQUIRED');
  }
  return trimmed;
}

function assertScrapReasonCode(reasonCode: string) {
  const trimmed = reasonCode.trim();
  if (!trimmed) {
    throw new Error('WO_SCRAP_REASON_REQUIRED');
  }
  return trimmed;
}

function assertSameWorkOrderExecution(
  workOrderId: string,
  execution: LockedExecutionRow
) {
  if (execution.work_order_id !== workOrderId) {
    throw new Error('WO_VOID_EXECUTION_WORK_ORDER_MISMATCH');
  }
}

async function findExistingVoidMovements(
  client: PoolClient,
  tenantId: string,
  executionId: string
) {
  const result = await client.query<ExistingVoidMovementsRow>(
    `SELECT id, source_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ($3, $4)
      FOR UPDATE`,
    [
      tenantId,
      executionId,
      WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
      WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE
    ]
  );
  return result.rows;
}

async function fetchVoidMovementPair(
  client: PoolClient,
  tenantId: string,
  executionId: string
) {
  const rows = await findExistingVoidMovements(client, tenantId, executionId);
  const component = rows.find((row) => row.source_type === WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE);
  const output = rows.find((row) => row.source_type === WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE);
  if (!component || !output) {
    return null;
  }
  if (component.status !== 'posted' || output.status !== 'posted') {
    throw new Error('WO_VOID_INCOMPLETE');
  }
  return {
    componentReturnMovementId: component.id,
    outputReversalMovementId: output.id
  };
}

async function buildWorkOrderIssueReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  issueId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    fetchAggregateView: () =>
      fetchWorkOrderIssue(params.tenantId, params.workOrderId, params.issueId, params.client),
    aggregateNotFoundError: new Error('WO_ISSUE_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      buildWorkOrderIssuePostedEvent({
        issueId: params.issueId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

async function buildWorkOrderCompletionReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  completionId: string;
  movementId: string;
  expectedLineCount?: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await verifyWorkOrderWipIntegrity(params.client, params.tenantId, params.workOrderId);
    },
    fetchAggregateView: () =>
      fetchWorkOrderCompletion(params.tenantId, params.workOrderId, params.completionId, params.client),
    aggregateNotFoundError: new Error('WO_COMPLETION_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.idempotencyKey ?? null),
      buildWorkOrderCompletionPostedEvent({
        executionId: params.completionId,
        workOrderId: params.workOrderId,
        movementId: params.movementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

async function buildWorkOrderBatchReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  expectedIssueLineCount?: number;
  expectedReceiveLineCount?: number;
  expectedIssueDeterministicHash?: string | null;
  expectedReceiveDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.issueMovementId,
        expectedLineCount: params.expectedIssueLineCount,
        expectedDeterministicHash: params.expectedIssueDeterministicHash ?? null
      },
      {
        movementId: params.receiveMovementId,
        expectedLineCount: params.expectedReceiveLineCount,
        expectedDeterministicHash: params.expectedReceiveDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await verifyWorkOrderWipIntegrity(params.client, params.tenantId, params.workOrderId);
    },
    fetchAggregateView: async () => {
      const res = await params.client.query<{
        execution_id: string;
        work_order_id: string;
        quantity_completed: string | number | null;
        work_order_status: string;
      }>(
        `SELECT e.id AS execution_id,
                e.work_order_id,
                w.quantity_completed,
                w.status AS work_order_status
           FROM work_order_executions e
           JOIN work_orders w
             ON w.id = e.work_order_id
            AND w.tenant_id = e.tenant_id
          WHERE e.tenant_id = $1
            AND e.id = $2
            AND e.work_order_id = $3
          FOR UPDATE OF e`,
        [params.tenantId, params.executionId, params.workOrderId]
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      return {
        workOrderId: row.work_order_id,
        executionId: row.execution_id,
        issueMovementId: params.issueMovementId,
        receiveMovementId: params.receiveMovementId,
        quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
        workOrderStatus: row.work_order_status,
        idempotencyKey: params.idempotencyKey ?? null,
        replayed: true
      };
    },
    aggregateNotFoundError: new Error('WO_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.issueMovementId, params.idempotencyKey ?? null),
      buildMovementPostedEvent(params.receiveMovementId, params.idempotencyKey ?? null),
      buildWorkOrderProductionReportedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        issueMovementId: params.issueMovementId,
        receiveMovementId: params.receiveMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

async function buildWorkOrderVoidReplayResult(params: {
  tenantId: string;
  workOrderId: string;
  executionId: string;
  componentReturnMovementId: string;
  outputReversalMovementId: string;
  expectedComponentLineCount?: number;
  expectedOutputLineCount?: number;
  expectedComponentDeterministicHash?: string | null;
  expectedOutputDeterministicHash?: string | null;
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.componentReturnMovementId,
        expectedLineCount: params.expectedComponentLineCount,
        expectedDeterministicHash: params.expectedComponentDeterministicHash ?? null
      },
      {
        movementId: params.outputReversalMovementId,
        expectedLineCount: params.expectedOutputLineCount,
        expectedDeterministicHash: params.expectedOutputDeterministicHash ?? null
      }
    ],
    client: params.client,
    preFetchIntegrityCheck: async () => {
      await verifyWorkOrderWipIntegrity(params.client, params.tenantId, params.workOrderId);
    },
    fetchAggregateView: async () => {
      const res = await params.client.query<{ id: string; work_order_id: string }>(
        `SELECT id, work_order_id
           FROM work_order_executions
          WHERE tenant_id = $1
            AND id = $2
            AND work_order_id = $3
          FOR UPDATE`,
        [params.tenantId, params.executionId, params.workOrderId]
      );
      if (res.rowCount === 0) {
        return null;
      }
      return {
        workOrderId: params.workOrderId,
        workOrderExecutionId: params.executionId,
        componentReturnMovementId: params.componentReturnMovementId,
        outputReversalMovementId: params.outputReversalMovementId,
        idempotencyKey: params.idempotencyKey ?? null,
        replayed: true
      };
    },
    aggregateNotFoundError: new Error('WO_VOID_EXECUTION_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.componentReturnMovementId, params.idempotencyKey ?? null),
      buildMovementPostedEvent(params.outputReversalMovementId, params.idempotencyKey ?? null),
      buildWorkOrderProductionReversedEvent({
        executionId: params.executionId,
        workOrderId: params.workOrderId,
        componentReturnMovementId: params.componentReturnMovementId,
        outputReversalMovementId: params.outputReversalMovementId,
        producerIdempotencyKey: params.idempotencyKey ?? null
      })
    ]
  });
}

async function loadMovementLineScopes(
  client: PoolClient,
  tenantId: string,
  movementId: string,
  quantitySign: 'positive' | 'negative'
) {
  const comparator = quantitySign === 'positive' ? '>' : '<';
  const result = await client.query<MovementLineScopeRow>(
    `SELECT iml.item_id,
            iml.location_id,
            l.warehouse_id,
            COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) AS qty_canonical,
            COALESCE(iml.canonical_uom, iml.uom) AS balance_uom,
            iml.unit_cost,
            iml.extended_cost
       FROM inventory_movement_lines iml
       JOIN locations l
         ON l.id = iml.location_id
        AND l.tenant_id = iml.tenant_id
      WHERE iml.tenant_id = $1
        AND iml.movement_id = $2
        AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) ${comparator} 0
      ORDER BY iml.item_id, iml.location_id, iml.id
      FOR UPDATE`,
    [tenantId, movementId]
  );
  return result.rows;
}

function movementLineUnitCost(line: MovementLineScopeRow): number {
  const qty = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
  const extendedCost = line.extended_cost !== null ? Math.abs(toNumber(line.extended_cost)) : null;
  if (extendedCost !== null && qty > 0) {
    return roundQuantity(extendedCost / qty);
  }
  return roundQuantity(Math.abs(toNumber(line.unit_cost ?? 0)));
}

async function assertVoidOutputStillInQa(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  productionMovementId: string
) {
  const layerRows = await client.query<{
    id: string;
    remaining_quantity: string | number;
    original_quantity: string | number;
    location_id: string;
  }>(
    `SELECT id, remaining_quantity, original_quantity, location_id
       FROM inventory_cost_layers
      WHERE tenant_id = $1
        AND movement_id = $2
        AND source_type = 'production'
        AND voided_at IS NULL
      FOR UPDATE`,
    [tenantId, productionMovementId]
  );
  if (layerRows.rowCount === 0) {
    throw new Error('WO_VOID_PRODUCTION_LAYER_MISSING');
  }

  const consumedRows = await client.query(
    `SELECT 1
       FROM cost_layer_consumptions
      WHERE tenant_id = $1
        AND cost_layer_id = ANY($2::uuid[])
      LIMIT 1`,
    [tenantId, layerRows.rows.map((row) => row.id)]
  );
  if ((consumedRows.rowCount ?? 0) > 0) {
    throw domainError('WO_VOID_OUTPUT_ALREADY_MOVED', {
      workOrderExecutionId: executionId
    });
  }

  for (const row of layerRows.rows) {
    const remaining = roundQuantity(toNumber(row.remaining_quantity));
    const original = roundQuantity(toNumber(row.original_quantity));
    if (Math.abs(remaining - original) > 1e-6) {
      throw domainError('WO_VOID_OUTPUT_ALREADY_MOVED', {
        workOrderExecutionId: executionId
      });
    }
    const roleRes = await client.query<{ role: string | null }>(
      `SELECT role
         FROM locations
        WHERE id = $1
          AND tenant_id = $2`,
      [row.location_id, tenantId]
    );
    if (roleRes.rows[0]?.role !== 'QA') {
      throw new Error('WO_VOID_OUTPUT_NOT_QA');
    }
  }
}

export async function fetchWorkOrderVoidReportResult(
  tenantId: string,
  workOrderId: string,
  workOrderExecutionId: string,
  client?: PoolClient
): Promise<WorkOrderVoidReportResult | null> {
  const executor = client ? client.query.bind(client) : query;
  const executionRes = await executor<LockedExecutionRow>(
    `SELECT id, work_order_id, status, occurred_at, consumption_movement_id, production_movement_id
       FROM work_order_executions
      WHERE tenant_id = $1
        AND id = $2
        AND work_order_id = $3`,
    [tenantId, workOrderExecutionId, workOrderId]
  );
  if (executionRes.rowCount === 0) {
    return null;
  }
  const movementRes = await executor<ExistingVoidMovementsRow>(
    `SELECT id, source_type, status
       FROM inventory_movements
      WHERE tenant_id = $1
        AND source_id = $2
        AND source_type IN ($3, $4)`,
    [
      tenantId,
      workOrderExecutionId,
      WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
      WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE
    ]
  );
  const component = movementRes.rows.find((row) => row.source_type === WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE);
  const output = movementRes.rows.find((row) => row.source_type === WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE);
  if (!component || !output || component.status !== 'posted' || output.status !== 'posted') {
    return null;
  }
  return {
    workOrderId,
    workOrderExecutionId,
    componentReturnMovementId: component.id,
    outputReversalMovementId: output.id,
    idempotencyKey: null,
    replayed: true
  };
}

export async function reportWorkOrderProduction(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderReportProductionInput,
  context: NegativeOverrideContext = {},
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderProductionReportResult> {
  const reportIdempotencyKey = resolveReportProductionIdempotencyKey(workOrderId, data, options);
  const outputQty = toNumber(data.outputQty);
  if (!(outputQty > 0)) {
    throw new Error('WO_REPORT_INVALID_OUTPUT_QTY');
  }
  if (Array.isArray(data.scrapOutputs) && data.scrapOutputs.length > 0) {
    throw new Error('WO_REPORT_SCRAP_NOT_SUPPORTED');
  }

  const workOrder = await getWorkOrderById(tenantId, workOrderId);
  if (!workOrder) {
    throw new Error('WO_NOT_FOUND');
  }
  if (workOrder.kind !== 'production') {
    throw new Error('WO_REPORT_KIND_UNSUPPORTED');
  }

  const outputUom = data.outputUom?.trim() || workOrder.outputUom;
  if (outputUom !== workOrder.outputUom) {
    throw new Error('WO_REPORT_OUTPUT_UOM_MISMATCH');
  }

  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('WO_REPORT_INVALID_OCCURRED_AT');
  }

  const routing = await deriveWorkOrderStageRouting(tenantId, {
    kind: workOrder.kind,
    outputItemId: workOrder.outputItemId,
    bomId: workOrder.bomId,
    defaultConsumeLocationId: workOrder.defaultConsumeLocationId,
    defaultProduceLocationId: workOrder.defaultProduceLocationId,
    produceToLocationIdSnapshot: workOrder.produceToLocationIdSnapshot
  });
  const produceLocationId = routing.defaultProduceLocation?.id ?? null;
  if (!produceLocationId) {
    throw new Error('WO_REPORT_DEFAULT_LOCATIONS_REQUIRED');
  }

  const requirements = await getWorkOrderRequirements(tenantId, workOrderId, outputQty);
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
  if (Array.isArray(data.consumptionOverrides)) {
    for (const override of [...data.consumptionOverrides].sort(compareNormalizedOverrideKey)) {
      if (overrides.has(override.componentItemId)) {
        throw new Error('WO_REPORT_OVERRIDE_DUPLICATE_COMPONENT');
      }
      overrides.set(override.componentItemId, {
        componentItemId: override.componentItemId,
        uom: override.uom,
        quantity: toNumber(override.quantity),
        reason: override.reason?.trim() || null
      });
    }
  }

  const consumeLines = await Promise.all(
    requirements.lines.map(async (line) => {
      const override = overrides.get(line.componentItemId);
      const quantity = override ? override.quantity : roundQuantity(toNumber(line.quantityRequired));
      if (quantity < 0) {
        throw new Error('WO_REPORT_OVERRIDE_NEGATIVE_COMPONENT_QTY');
      }
      if (quantity === 0) {
        return null;
      }
      const consumeLocation = await deriveComponentConsumeLocation(
        tenantId,
        {
          kind: workOrder.kind,
          outputItemId: workOrder.outputItemId,
          bomId: workOrder.bomId,
          defaultConsumeLocationId: workOrder.defaultConsumeLocationId,
          defaultProduceLocationId: workOrder.defaultProduceLocationId,
          produceToLocationIdSnapshot: workOrder.produceToLocationIdSnapshot
        },
        { componentItemId: line.componentItemId }
      );
      if (!consumeLocation) {
        throw new Error('WO_REPORT_DEFAULT_LOCATIONS_REQUIRED');
      }
      return {
        componentItemId: line.componentItemId,
        fromLocationId: consumeLocation.id,
        uom: override?.uom ?? line.uom,
        quantity,
        reasonCode: override ? 'work_order_backflush_override' : 'work_order_backflush',
        notes: override?.reason ?? undefined
      };
    })
  );
  const resolvedConsumeLines = consumeLines.filter((line): line is NonNullable<typeof line> => line !== null);

  if (resolvedConsumeLines.length === 0) {
    throw new Error('WO_REPORT_NO_COMPONENT_CONSUMPTION');
  }
  if (Array.isArray(data.inputLots) && data.inputLots.length > 0) {
    const consumableComponentIds = new Set(resolvedConsumeLines.map((line) => line.componentItemId));
    for (const inputLot of data.inputLots) {
      if (!consumableComponentIds.has(inputLot.componentItemId)) {
        throw new Error('WO_REPORT_INPUT_LOT_COMPONENT_UNKNOWN');
      }
    }
  }

  const produceLines: WorkOrderBatchInput['produceLines'] = [
    {
      outputItemId: workOrder.outputItemId,
      toLocationId: produceLocationId,
      uom: outputUom,
      quantity: outputQty,
      reasonCode: 'work_order_production_receipt'
    }
  ];

  const batchResult = await recordWorkOrderBatch(
    tenantId,
    workOrderId,
      {
        occurredAt: occurredAt.toISOString(),
        notes: data.notes ?? undefined,
        consumeLines: resolvedConsumeLines,
        produceLines
      },
    context,
    {
      idempotencyKey: reportIdempotencyKey,
      idempotencyEndpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_PRODUCTION
    }
  );

  if (shouldSimulateLotLinkFailureOnce(reportIdempotencyKey, batchResult.replayed)) {
    throw domainError('WO_REPORT_LOT_LINK_INCOMPLETE', {
      reason: 'simulated_failure_after_post_before_lot_link',
      workOrderId,
      productionReportId: batchResult.executionId
    });
  }

  let lotTracking: Awaited<ReturnType<typeof persistWorkOrderLotLinks>>;
  try {
    lotTracking = await persistWorkOrderLotLinks(tenantId, {
      executionId: batchResult.executionId,
      outputItemId: workOrder.outputItemId,
      outputQty,
      outputUom,
      outputLotId: data.outputLotId,
      outputLotCode: data.outputLotCode,
      inputLots: data.inputLots,
      workOrderNumber: workOrder.number ?? workOrder.id,
      occurredAt
    });
  } catch (error: any) {
    if (!isNonRetryableLotLinkError(error)) {
      throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        reason: 'lot_linking_incomplete_after_post',
        workOrderId,
        executionId: batchResult.executionId,
        sqlState: error?.retrySqlState ?? error?.code ?? null,
        hint: 'Retry with the same Idempotency-Key to finalize lot linking.'
      });
    }
    throw error;
  }

  if (lotTracking?.outputLotId || data.productionBatchId) {
    const metadata: Record<string, unknown> = {};
    if (lotTracking?.outputLotId) {
      metadata.lotId = lotTracking.outputLotId;
    }
    if (data.productionBatchId) {
      metadata.productionBatchId = data.productionBatchId;
    }
    await query(
      `UPDATE work_order_executions
          SET output_lot_id = COALESCE($1, output_lot_id),
              production_batch_id = COALESCE($2, production_batch_id)
        WHERE tenant_id = $3
          AND id = $4`,
      [lotTracking?.outputLotId ?? null, data.productionBatchId ?? null, tenantId, batchResult.executionId]
    );
    await query(
      `UPDATE inventory_movements
          SET lot_id = COALESCE($1, lot_id),
              production_batch_id = COALESCE($2, production_batch_id),
              metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        WHERE tenant_id = $4
          AND id = $5`,
      [
        lotTracking?.outputLotId ?? null,
        data.productionBatchId ?? null,
        JSON.stringify(metadata),
        tenantId,
        batchResult.receiveMovementId
      ]
    );
  }

  return {
    workOrderId,
    productionReportId: batchResult.executionId,
    componentIssueMovementId: batchResult.issueMovementId,
    productionReceiptMovementId: batchResult.receiveMovementId,
    idempotencyKey: batchResult.idempotencyKey ?? reportIdempotencyKey,
    replayed: batchResult.replayed,
    lotTracking
  };
}

export async function voidWorkOrderProductionReport(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderVoidReportProductionInput,
  actor: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderVoidReportResult> {
  const idempotencyKey = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  const reason = assertVoidReason(data.reason);
  const idempotencyRequestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_VOID_REPORT_PRODUCTION,
      body: {
        workOrderId,
        workOrderExecutionId: data.workOrderExecutionId,
        reason,
        notes: data.notes ?? null
      }
    })
    : null;

  let execution: LockedExecutionRow | null = null;
  let componentLines: MovementLineScopeRow[] = [];
  let outputLines: MovementLineScopeRow[] = [];

  return runInventoryCommand<WorkOrderVoidReportResult>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_VOID_REPORT_PRODUCTION,
    operation: 'work_order_batch_void',
    idempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      return (
        await buildWorkOrderVoidReplayResult({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.workOrderExecutionId,
          componentReturnMovementId: responseBody.componentReturnMovementId,
          outputReversalMovementId: responseBody.outputReversalMovementId,
          client,
          idempotencyKey
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      const executionRes = await client.query<LockedExecutionRow>(
        `SELECT id,
                work_order_id,
                status,
                occurred_at,
                consumption_movement_id,
                production_movement_id
           FROM work_order_executions
          WHERE tenant_id = $1
            AND id = $2
            AND work_order_id = $3
          FOR UPDATE`,
        [tenantId, data.workOrderExecutionId, workOrderId]
      );
      if (executionRes.rowCount === 0) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }
      execution = executionRes.rows[0];
      assertSameWorkOrderExecution(workOrderId, execution);
      const currentState =
        execution.status === 'posted' && execution.production_movement_id && execution.consumption_movement_id
          ? 'reported_production'
          : execution.status === 'posted'
            ? 'posted_completion'
            : 'planned_completion';
      assertManufacturingTransition({
        flow: 'reversal',
        currentState,
        allowedFrom: ['reported_production'],
        targetState: 'reversal',
        workOrderId,
        executionOrDocumentId: execution.id
      });
      if (!execution.consumption_movement_id || !execution.production_movement_id) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }

      const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
      if (existingPair) {
        return [];
      }

      const originalMovements = await client.query<{
        id: string;
        movement_type: string;
        status: string;
      }>(
        `SELECT id, movement_type, status
           FROM inventory_movements
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
          FOR UPDATE`,
        [tenantId, [execution.consumption_movement_id, execution.production_movement_id]]
      );
      const currentExecution = execution;
      if (!currentExecution) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }
      const originalIssue = originalMovements.rows.find(
        (row) => row.id === currentExecution.consumption_movement_id
      );
      const originalProduction = originalMovements.rows.find(
        (row) => row.id === currentExecution.production_movement_id
      );
      if (!originalIssue || !originalProduction) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }
      if (originalIssue.status !== 'posted' || originalProduction.status !== 'posted') {
        throw new Error('WO_VOID_EXECUTION_NOT_POSTED');
      }
      if (originalIssue.movement_type !== 'issue' || originalProduction.movement_type !== 'receive') {
        throw new Error('WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID');
      }

      componentLines = await loadMovementLineScopes(
        client,
        tenantId,
        execution.consumption_movement_id,
        'negative'
      );
      outputLines = await loadMovementLineScopes(
        client,
        tenantId,
        execution.production_movement_id,
        'positive'
      );
      if (componentLines.length === 0 || outputLines.length === 0) {
        throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
      }

      await assertVoidOutputStillInQa(
        client,
        tenantId,
        execution.id,
        execution.production_movement_id
      );

      const missingWarehouseBindings = [
        ...componentLines.filter((line) => !line.warehouse_id).map((line) => line.location_id),
        ...outputLines.filter((line) => !line.warehouse_id).map((line) => line.location_id)
      ];
      if (missingWarehouseBindings.length > 0) {
        throw new Error(
          `WO_VOID_LOCATION_WAREHOUSE_MISSING:${Array.from(new Set(missingWarehouseBindings)).join(',')}`
        );
      }

      return [
        ...componentLines.map((line) => ({
          tenantId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id
        })),
        ...outputLines.map((line) => ({
          tenantId,
          warehouseId: line.warehouse_id ?? '',
          itemId: line.item_id
        }))
      ];
    },
    execute: async ({ client }) => {
      if (!execution) {
        throw new Error('WO_VOID_EXECUTION_NOT_FOUND');
      }

      if (
        componentLines.length === 0
        && outputLines.length === 0
        && execution.consumption_movement_id
        && execution.production_movement_id
      ) {
        componentLines = await loadMovementLineScopes(
          client,
          tenantId,
          execution.consumption_movement_id,
          'negative'
        );
        outputLines = await loadMovementLineScopes(
          client,
          tenantId,
          execution.production_movement_id,
          'positive'
        );
      }
      const currentExecution = execution;

      const plannedOutputLines = sortDeterministicMovementLines(
        await Promise.all(outputLines.map(async (line) => {
          const quantityToReverse = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
          const canonicalFields = await getCanonicalMovementFields(
            tenantId,
            line.item_id,
            -quantityToReverse,
            line.balance_uom,
            client
          );
          return {
            sourceLineId: `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReverse}`,
            warehouseId: line.warehouse_id ?? '',
            line,
            canonicalFields,
            reasonCode: 'work_order_void_output',
            lineNotes: `Void output reversal for work order execution ${currentExecution.id}`
          };
        })),
        (entry) => ({
          tenantId,
          warehouseId: entry.warehouseId,
          locationId: entry.line.location_id,
          itemId: entry.line.item_id,
          canonicalUom: entry.canonicalFields.canonicalUom,
          sourceLineId: entry.sourceLineId
        })
      );
      const plannedComponentLines = sortDeterministicMovementLines(
        await Promise.all(componentLines.map(async (line) => {
          const quantityToReturn = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
          const canonicalFields = await getCanonicalMovementFields(
            tenantId,
            line.item_id,
            quantityToReturn,
            line.balance_uom,
            client
          );
          return {
            sourceLineId: `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReturn}`,
            warehouseId: line.warehouse_id ?? '',
            line,
            canonicalFields,
            reasonCode: 'work_order_void_component_return',
            lineNotes: `Void component return for work order execution ${currentExecution.id}`
          };
        })),
        (entry) => ({
          tenantId,
          warehouseId: entry.warehouseId,
          locationId: entry.line.location_id,
          itemId: entry.line.item_id,
          canonicalUom: entry.canonicalFields.canonicalUom,
          sourceLineId: entry.sourceLineId
        })
      );
      const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
      if (existingPair) {
        return buildWorkOrderVoidReplayResult({
          tenantId,
          workOrderId,
          executionId: execution.id,
          componentReturnMovementId: existingPair.componentReturnMovementId,
          outputReversalMovementId: existingPair.outputReversalMovementId,
          expectedComponentLineCount: plannedComponentLines.length,
          expectedOutputLineCount: plannedOutputLines.length,
          client,
          idempotencyKey
        });
      }

      const now = new Date();
      const outputMovementId = uuidv4();
      const componentMovementId = uuidv4();
      const plannedOutputMovementLines = await Promise.all(plannedOutputLines.map(async (plannedOutputLine) => {
        const canonicalQty = Math.abs(plannedOutputLine.canonicalFields.quantityDeltaCanonical);
        const consumptionPlan = await planCostLayerConsumption({
          tenant_id: tenantId,
          item_id: plannedOutputLine.line.item_id,
          location_id: plannedOutputLine.line.location_id,
          quantity: canonicalQty,
          consumption_type: 'scrap',
          consumption_document_id: execution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${execution.id}`
        });
        return {
          plannedOutputLine,
          consumptionPlan,
          unitCost: canonicalQty > 0 ? consumptionPlan.total_cost / canonicalQty : null,
          extendedCost: -consumptionPlan.total_cost
        };
      }));
      const plannedComponentMovementLines = plannedComponentLines.map((plannedComponentLine) => {
        const unitCost = movementLineUnitCost(plannedComponentLine.line);
        const extendedCost = roundQuantity(
          plannedComponentLine.canonicalFields.quantityDeltaCanonical * unitCost
        );
        return {
          plannedComponentLine,
          unitCost,
          extendedCost
        };
      });

      const outputMovement = await persistInventoryMovement(client, {
        id: outputMovementId,
        tenantId,
        movementType: 'issue',
        status: 'posted',
        externalRef: `${WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE}:${execution.id}:${workOrderId}`,
        sourceType: WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
        sourceId: execution.id,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:output` : null,
        occurredAt: now,
        postedAt: now,
        notes: data.notes ?? `Void production output for execution ${execution.id}: ${reason}`,
        metadata: {
          workOrderId,
          workOrderExecutionId: execution.id,
          reason
        },
        createdAt: now,
        updatedAt: now,
        lines: plannedOutputMovementLines.map(({ plannedOutputLine, unitCost, extendedCost }) => ({
          warehouseId: plannedOutputLine.warehouseId,
          sourceLineId: plannedOutputLine.sourceLineId,
          itemId: plannedOutputLine.line.item_id,
          locationId: plannedOutputLine.line.location_id,
          quantityDelta: plannedOutputLine.canonicalFields.quantityDeltaCanonical,
          uom: plannedOutputLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: plannedOutputLine.canonicalFields.quantityDeltaEntered,
          uomEntered: plannedOutputLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: plannedOutputLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: plannedOutputLine.canonicalFields.canonicalUom,
          uomDimension: plannedOutputLine.canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode: plannedOutputLine.reasonCode,
          lineNotes: plannedOutputLine.lineNotes,
          createdAt: now
        }))
      });
      const componentMovement = await persistInventoryMovement(client, {
        id: componentMovementId,
        tenantId,
        movementType: 'receive',
        status: 'posted',
        externalRef: `${WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE}:${execution.id}:${workOrderId}`,
        sourceType: WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE,
        sourceId: execution.id,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:components` : null,
        occurredAt: now,
        postedAt: now,
        notes: data.notes ?? `Void component return for execution ${execution.id}: ${reason}`,
        metadata: {
          workOrderId,
          workOrderExecutionId: execution.id,
          reason
        },
        createdAt: now,
        updatedAt: now,
        lines: plannedComponentMovementLines.map(({ plannedComponentLine, unitCost, extendedCost }) => ({
          warehouseId: plannedComponentLine.warehouseId,
          sourceLineId: plannedComponentLine.sourceLineId,
          itemId: plannedComponentLine.line.item_id,
          locationId: plannedComponentLine.line.location_id,
          quantityDelta: plannedComponentLine.canonicalFields.quantityDeltaCanonical,
          uom: plannedComponentLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: plannedComponentLine.canonicalFields.quantityDeltaEntered,
          uomEntered: plannedComponentLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: plannedComponentLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: plannedComponentLine.canonicalFields.canonicalUom,
          uomDimension: plannedComponentLine.canonicalFields.uomDimension,
          unitCost,
          extendedCost,
          reasonCode: plannedComponentLine.reasonCode,
          lineNotes: plannedComponentLine.lineNotes,
          createdAt: now
        }))
      });

      if (!outputMovement.created || !componentMovement.created) {
        const replayPair = await fetchVoidMovementPair(client, tenantId, execution.id);
        if (replayPair) {
          return buildWorkOrderVoidReplayResult({
            tenantId,
            workOrderId,
            executionId: execution.id,
            componentReturnMovementId: replayPair.componentReturnMovementId,
            outputReversalMovementId: replayPair.outputReversalMovementId,
            expectedComponentLineCount: plannedComponentLines.length,
            expectedOutputLineCount: plannedOutputLines.length,
            client,
            idempotencyKey
          });
        }
        throw new Error('WO_VOID_INCOMPLETE');
      }

      const projectionOps: InventoryCommandProjectionOp[] = [];
      let totalOutputReversalCost = 0;
      let totalComponentReturnCost = 0;

      for (const { plannedOutputLine, consumptionPlan } of plannedOutputMovementLines) {
        const canonicalQty = Math.abs(plannedOutputLine.canonicalFields.quantityDeltaCanonical);
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: plannedOutputLine.line.item_id,
          location_id: plannedOutputLine.line.location_id,
          quantity: canonicalQty,
          consumption_type: 'scrap',
          consumption_document_id: execution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${execution.id}`,
          plan: consumptionPlan
        });
        totalOutputReversalCost += consumptionPlan.total_cost;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: plannedOutputLine.line.item_id,
            locationId: plannedOutputLine.line.location_id,
            uom: plannedOutputLine.canonicalFields.canonicalUom,
            deltaOnHand: plannedOutputLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      for (const { plannedComponentLine, unitCost, extendedCost } of plannedComponentMovementLines) {
        totalComponentReturnCost += extendedCost;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: plannedComponentLine.line.item_id,
            locationId: plannedComponentLine.line.location_id,
            uom: plannedComponentLine.canonicalFields.canonicalUom,
            deltaOnHand: plannedComponentLine.canonicalFields.quantityDeltaCanonical
          })
        );
        await createCostLayer({
          tenant_id: tenantId,
          item_id: plannedComponentLine.line.item_id,
          location_id: plannedComponentLine.line.location_id,
          uom: plannedComponentLine.canonicalFields.canonicalUom,
          quantity: plannedComponentLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost,
          source_type: 'adjustment',
          source_document_id: execution.id,
          movement_id: componentMovementId,
          notes: `Work-order void component return for execution ${execution.id}`,
          client
        });
      }

      const originalValuationRecords = await loadWorkOrderWipValuationRecordsByMovementIds(
        client,
        tenantId,
        [execution.consumption_movement_id!, execution.production_movement_id!]
      );
      const originalIssueValuation = originalValuationRecords.find((row) => row.valuation_type === 'issue');
      const originalReportValuation = originalValuationRecords.find((row) =>
        row.valuation_type === 'report' || row.valuation_type === 'completion'
      );
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: execution.id,
        movementId: outputMovementId,
        valuationType: 'reversal_to_wip',
        valueDelta: totalOutputReversalCost,
        reversalOfValuationRecordId: originalReportValuation?.id ?? null,
        notes: `Work-order reversal moves finished-goods value back into WIP for execution ${execution.id}`
      });
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: execution.id,
        movementId: componentMovementId,
        valuationType: 'reversal_from_wip',
        valueDelta: -totalComponentReturnCost,
        reversalOfValuationRecordId: originalIssueValuation?.id ?? null,
        notes: `Work-order reversal returns component value out of WIP for execution ${execution.id}`
      });
      await verifyWorkOrderWipIntegrity(client, tenantId, workOrderId);

      projectionOps.push(async (projectionClient) => {
        await recordAuditLog(
          {
            tenantId,
            actorType: actor.type,
            actorId: actor.id ?? null,
            action: 'update',
            entityType: 'work_order_execution',
            entityId: execution!.id,
            occurredAt: now,
            metadata: {
              workOrderId,
              workOrderExecutionId: execution!.id,
              outputReversalMovementId: outputMovementId,
              componentReturnMovementId: componentMovementId,
              reason
            }
          },
          projectionClient
        );
      });

      return {
        responseBody: {
          workOrderId,
          workOrderExecutionId: execution.id,
          componentReturnMovementId: componentMovementId,
          outputReversalMovementId: outputMovementId,
          idempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(componentMovementId, idempotencyKey),
          buildMovementPostedEvent(outputMovementId, idempotencyKey),
          buildWorkOrderProductionReversedEvent({
            executionId: execution.id,
            workOrderId,
            componentReturnMovementId: componentMovementId,
            outputReversalMovementId: outputMovementId,
            producerIdempotencyKey: idempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}

export async function reportWorkOrderScrap(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderReportScrapInput,
  actor: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
): Promise<WorkOrderScrapReportResult> {
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('WO_SCRAP_INVALID_OCCURRED_AT');
  }
  const quantity = roundQuantity(toNumber(data.quantity));
  if (!(quantity > 0)) {
    throw new Error('WO_SCRAP_INVALID_QTY');
  }
  const reasonCode = assertScrapReasonCode(data.reasonCode);
  const idempotencyKey = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  const scrapSourceId = idempotencyKey
    ? `idempotency:${idempotencyKey}`
    : `execution:${data.workOrderExecutionId}:scrap:${uuidv4()}`;
  const occurredAtForHash = data.occurredAt ? new Date(data.occurredAt).toISOString() : null;
  const idempotencyRequestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_SCRAP,
      body: {
        workOrderId,
        workOrderExecutionId: data.workOrderExecutionId,
        outputItemId: data.outputItemId ?? null,
        quantity,
        uom: data.uom,
        reasonCode,
        notes: data.notes ?? null,
        occurredAt: occurredAtForHash
      }
    })
    : null;

  let execution: LockedExecutionRow | null = null;
  let itemId = '';
  let sourceLocationId = '';
  let warehouseId = '';
  let scrapLocationId = '';
  let preparedTransfer: PreparedTransferMutation | null = null;

  return runInventoryCommand<WorkOrderScrapReportResult>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_SCRAP,
    operation: 'work_order_report_scrap',
    idempotencyKey,
    requestHash: idempotencyRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      const executionRes = await client.query<LockedExecutionRow>(
        `SELECT id,
                work_order_id,
                status,
                occurred_at,
                consumption_movement_id,
                production_movement_id
           FROM work_order_executions
          WHERE tenant_id = $1
            AND id = $2
            AND work_order_id = $3
          FOR UPDATE`,
        [tenantId, responseBody.workOrderExecutionId, workOrderId]
      );
      if (executionRes.rowCount === 0) {
        throw buildReplayCorruptionError({
          tenantId,
          aggregateType: 'work_order_execution',
          aggregateId: responseBody.workOrderExecutionId,
          reason: 'work_order_scrap_execution_missing'
        });
      }
      const currentExecution = executionRes.rows[0];
      if (!currentExecution.production_movement_id) {
        throw buildReplayCorruptionError({
          tenantId,
          aggregateType: 'work_order_execution',
          aggregateId: responseBody.workOrderExecutionId,
          reason: 'work_order_scrap_execution_movement_missing'
        });
      }

      const qaSourceRows = await client.query<{
        location_id: string;
        warehouse_id: string | null;
      }>(
        `SELECT iml.location_id,
                l.warehouse_id
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
            AND iml.item_id = $3
            AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
            AND l.role = 'QA'
          GROUP BY iml.location_id, l.warehouse_id`,
        [tenantId, currentExecution.production_movement_id, responseBody.itemId]
      );
      if (qaSourceRows.rowCount !== 1 || !qaSourceRows.rows[0]?.warehouse_id) {
        throw buildReplayCorruptionError({
          tenantId,
          aggregateType: 'work_order_execution',
          aggregateId: responseBody.workOrderExecutionId,
          reason: 'work_order_scrap_replay_scope_unresolved'
        });
      }
      const replaySourceLocationId = qaSourceRows.rows[0].location_id;
      const replayWarehouseId = qaSourceRows.rows[0].warehouse_id;
      const replayScrapLocationId = await getWarehouseDefaultLocationId(
        tenantId,
        replayWarehouseId,
        'SCRAP',
        client
      );
      if (!replayScrapLocationId) {
        throw buildReplayCorruptionError({
          tenantId,
          aggregateType: 'work_order_execution',
          aggregateId: responseBody.workOrderExecutionId,
          reason: 'work_order_scrap_location_missing'
        });
      }

      await buildTransferReplayResult({
        tenantId,
        movementId: responseBody.scrapMovementId,
        normalizedIdempotencyKey: idempotencyKey ? `${idempotencyKey}:transfer` : null,
        replayed: true,
        client,
        sourceLocationId: replaySourceLocationId,
        destinationLocationId: replayScrapLocationId,
        itemId: responseBody.itemId,
        quantity: responseBody.quantity,
        uom: responseBody.uom,
        sourceWarehouseId: replayWarehouseId,
        destinationWarehouseId: replayWarehouseId,
        expectedLineCount: 2
      });
      return {
        ...responseBody,
        replayed: true
      };
    },
    lockTargets: async (client) => {
      execution = null;
      itemId = '';
      sourceLocationId = '';
      warehouseId = '';
      scrapLocationId = '';
      preparedTransfer = null;

      const executionRes = await client.query<LockedExecutionRow>(
        `SELECT id,
                work_order_id,
                status,
                occurred_at,
                consumption_movement_id,
                production_movement_id
           FROM work_order_executions
          WHERE tenant_id = $1
            AND id = $2
            AND work_order_id = $3
          FOR UPDATE`,
        [tenantId, data.workOrderExecutionId, workOrderId]
      );
      if (executionRes.rowCount === 0) {
        throw new Error('WO_SCRAP_EXECUTION_NOT_FOUND');
      }
      execution = executionRes.rows[0];
      assertSameWorkOrderExecution(workOrderId, execution);
      if (execution.status !== 'posted' || !execution.production_movement_id) {
        throw new Error('WO_SCRAP_EXECUTION_NOT_POSTED');
      }

      const outputItemRes = await client.query<{ output_item_id: string }>(
        `SELECT output_item_id
           FROM work_orders
          WHERE tenant_id = $1
            AND id = $2`,
        [tenantId, workOrderId]
      );
      if (outputItemRes.rowCount === 0) {
        throw new Error('WO_NOT_FOUND');
      }
      const outputItemId = outputItemRes.rows[0].output_item_id;
      itemId = data.outputItemId ?? outputItemId;
      if (itemId !== outputItemId) {
        throw new Error('WO_SCRAP_OUTPUT_ITEM_MISMATCH');
      }

      const qaSourceRows = await client.query<{
        location_id: string;
        warehouse_id: string | null;
        role: string | null;
        total_qty: string | number;
      }>(
        `SELECT iml.location_id,
                l.warehouse_id,
                l.role,
                SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta))::numeric AS total_qty
           FROM inventory_movement_lines iml
           JOIN locations l
             ON l.id = iml.location_id
            AND l.tenant_id = iml.tenant_id
          WHERE iml.tenant_id = $1
            AND iml.movement_id = $2
            AND iml.item_id = $3
            AND COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
          GROUP BY iml.location_id, l.warehouse_id, l.role
         HAVING l.role = 'QA'`,
        [tenantId, execution.production_movement_id, itemId]
      );
      if (qaSourceRows.rowCount !== 1) {
        throw new Error('WO_SCRAP_QA_SOURCE_AMBIGUOUS');
      }
      const qaSource = qaSourceRows.rows[0];
      if (!qaSource.warehouse_id) {
        throw new Error('WO_SCRAP_QA_SOURCE_WAREHOUSE_MISSING');
      }
      sourceLocationId = qaSource.location_id;
      warehouseId = qaSource.warehouse_id;
      scrapLocationId = await getWarehouseDefaultLocationId(tenantId, warehouseId, 'SCRAP', client);
      if (!scrapLocationId) {
        throw new Error('WO_SCRAP_LOCATION_REQUIRED');
      }

      const availableRes = await client.query<{ qty: string | number }>(
        `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS qty
           FROM inventory_cost_layers
          WHERE tenant_id = $1
            AND movement_id = $2
            AND source_type = 'production'
            AND item_id = $3
            AND location_id = $4
            AND voided_at IS NULL`,
        [tenantId, execution.production_movement_id, itemId, sourceLocationId]
      );
      const availableQty = roundQuantity(toNumber(availableRes.rows[0]?.qty ?? 0));
      if (quantity - availableQty > 1e-6) {
        throw domainError('WO_SCRAP_EXCEEDS_EXECUTION_QA_AVAILABLE', {
          workOrderExecutionId: execution.id,
          itemId,
          requestedQty: quantity,
          availableQty
        });
      }

      preparedTransfer = await prepareTransferMutation(
        {
          tenantId,
          sourceLocationId,
          destinationLocationId: scrapLocationId,
          warehouseId,
          itemId,
          quantity,
          uom: data.uom,
          sourceType: WORK_ORDER_SCRAP_SOURCE_TYPE,
          sourceId: scrapSourceId,
          movementType: 'transfer',
          reasonCode,
          notes: data.notes ?? `Work-order scrap for execution ${execution.id}`,
          occurredAt,
          actorId: actor.id ?? null,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:transfer` : null
        },
        client
      );
      return buildTransferLockTargets(preparedTransfer);
    },
    execute: async ({ client }) => {
      if (!execution || !preparedTransfer || !itemId || !sourceLocationId || !scrapLocationId || !warehouseId) {
        throw new Error('WO_SCRAP_PREPARE_REQUIRED');
      }
      const transferExecution = await executeTransferInventoryMutation(preparedTransfer, client);
      const now = new Date();
      const projectionOps = [...transferExecution.projectionOps];
      if (transferExecution.result.created) {
        projectionOps.push(async (projectionClient) => {
          await projectionClient.query(
            `UPDATE work_orders
                SET quantity_scrapped = COALESCE(quantity_scrapped, 0) + $1,
                    status = CASE
                      WHEN COALESCE(quantity_completed, 0) + COALESCE(quantity_scrapped, 0) + $1 >= quantity_planned
                        THEN 'completed'
                      WHEN COALESCE(quantity_completed, 0) > 0 OR COALESCE(quantity_scrapped, 0) + $1 > 0
                        THEN 'partially_completed'
                      ELSE status
                    END,
                    completed_at = CASE
                      WHEN COALESCE(quantity_completed, 0) + COALESCE(quantity_scrapped, 0) + $1 >= quantity_planned
                        THEN COALESCE(completed_at, $2)
                      ELSE completed_at
                    END,
                    updated_at = $2
              WHERE id = $3
                AND tenant_id = $4`,
            [quantity, now, workOrderId, tenantId]
          );
        });
      }
      return {
        responseBody: {
          workOrderId,
          workOrderExecutionId: execution.id,
          scrapMovementId: transferExecution.result.movementId,
          itemId,
          quantity,
          uom: data.uom,
          idempotencyKey,
          replayed: !transferExecution.result.created
        },
        responseStatus: transferExecution.result.created ? 201 : 200,
        events: transferExecution.events,
        projectionOps
      };
    }
  });
}

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {},
  options?: { idempotencyKey?: string | null; idempotencyEndpoint?: string }
): Promise<{
  workOrderId: string;
  executionId: string;
  issueMovementId: string;
  receiveMovementId: string;
  quantityCompleted: number;
  workOrderStatus: string;
  idempotencyKey: string | null;
  replayed: boolean;
}> {
  const batchIdempotencyKey = options?.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const idempotencyEndpoint = options?.idempotencyEndpoint ?? IDEMPOTENCY_ENDPOINTS.WORK_ORDER_RECORD_BATCH;
  const normalizedConsumes: NormalizedBatchConsumeLine[] = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return {
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });
  const normalizedProduces: NormalizedBatchProduceLine[] = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return {
      outputItemId: line.outputItemId,
      toLocationId: line.toLocationId,
      quantity,
      uom: line.uom,
      reasonCode: line.reasonCode ?? null,
      packSize: line.packSize ?? null,
      notes: line.notes ?? null
    };
  });
  const occurredAt = new Date(data.occurredAt);
  const normalizedRequestPayload = normalizeBatchRequestPayload({
    workOrderId,
    occurredAt,
    notes: data.notes ?? null,
    overrideNegative: data.overrideNegative,
    overrideReason: data.overrideReason ?? null,
    consumeLines: normalizedConsumes,
    produceLines: normalizedProduces
  });
  const requestHash = hashNormalizedBatchRequest(normalizedRequestPayload);
  const transactionalRequestHash = batchIdempotencyKey
    ? hashTransactionalIdempotencyRequest({
      method: 'POST',
      endpoint: idempotencyEndpoint,
      body: normalizedRequestPayload
    })
    : null;
  let workOrder: WorkOrderRow | null = null;
  let existingBatchReplay: Awaited<ReturnType<typeof findPostedBatchByIdempotencyKey>> | null = null;
  let warehouseByLocationId = new Map<string, string>();
  let consumeLinesOrdered: NormalizedBatchConsumeLine[] = [];
  let produceLinesOrdered: NormalizedBatchProduceLine[] = [];

  return runInventoryCommand<{
    workOrderId: string;
    executionId: string;
    issueMovementId: string;
    receiveMovementId: string;
    quantityCompleted: number;
    workOrderStatus: string;
    idempotencyKey: string | null;
    replayed: boolean;
  }>({
    tenantId,
    endpoint: idempotencyEndpoint,
    operation: 'work_order_batch_post',
    idempotencyKey: batchIdempotencyKey,
    requestHash: transactionalRequestHash,
    retryOptions: WORK_ORDER_POST_RETRY_OPTIONS,
    onReplay: async ({ client, responseBody }) => {
      return (
        await buildWorkOrderBatchReplayResult({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.executionId,
          issueMovementId: responseBody.issueMovementId,
          receiveMovementId: responseBody.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey
        })
      ).responseBody;
    },
    lockTargets: async (client) => {
      existingBatchReplay = null;
      if (batchIdempotencyKey) {
        existingBatchReplay = await findPostedBatchByIdempotencyKey(
          client,
          tenantId,
          batchIdempotencyKey,
          requestHash
        );
        if (existingBatchReplay) {
          return [];
        }
      }

      workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      if (isTerminalWorkOrderStatus(workOrder.status)) {
        throw new Error('WO_INVALID_STATE');
      }
      await ensureWorkOrderReservationsReady(tenantId, workOrderId, client);
      if (normalizeWorkOrderStatus(workOrder.status) === 'draft') {
        await client.query(
          `UPDATE work_orders
              SET status = 'ready',
                  released_at = COALESCE(released_at, $1),
                  updated_at = $1
            WHERE tenant_id = $2
              AND id = $3`,
          [occurredAt, tenantId, workOrderId]
        );
        workOrder.status = 'ready';
      }
      consumeLinesOrdered = [...normalizedConsumes].sort(compareBatchConsumeKey);
      produceLinesOrdered = [...normalizedProduces].sort(compareBatchProduceKey);
      const isDisassembly = workOrder.kind === 'disassembly';

      if (!isDisassembly) {
        for (const line of produceLinesOrdered) {
          if (line.outputItemId !== workOrder.output_item_id) {
            throw new Error('WO_BATCH_ITEM_MISMATCH');
          }
        }
      } else {
        for (const line of consumeLinesOrdered) {
          if (line.componentItemId !== workOrder.output_item_id) {
            throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
          }
        }
      }

      const itemIds = Array.from(
        new Set([
          ...consumeLinesOrdered.map((line) => line.componentItemId),
          ...produceLinesOrdered.map((line) => line.outputItemId)
        ])
      );
      const locationIds = Array.from(
        new Set([
          ...consumeLinesOrdered.map((line) => line.fromLocationId),
          ...produceLinesOrdered.map((line) => line.toLocationId)
        ])
      );
      if (itemIds.length > 0) {
        const itemRes = await client.query<{ id: string }>(
          `SELECT id
             FROM items
            WHERE id = ANY($1)
              AND tenant_id = $2`,
          [itemIds, tenantId]
        );
        const found = new Set(itemRes.rows.map((row) => row.id));
        const missingItems = itemIds.filter((id) => !found.has(id));
        if (missingItems.length > 0) {
          throw new Error(`WO_BATCH_ITEMS_MISSING:${missingItems.join(',')}`);
        }
      }

      warehouseByLocationId = new Map<string, string>();
      if (locationIds.length > 0) {
        const locRes = await client.query<{
          id: string;
          warehouse_id: string | null;
          role: string | null;
          is_sellable: boolean;
        }>(
          `SELECT id, warehouse_id, role, is_sellable
             FROM locations
            WHERE id = ANY($1)
              AND tenant_id = $2`,
          [locationIds, tenantId]
        );
        const found = new Set(locRes.rows.map((row) => row.id));
        const missingLocs = locationIds.filter((id) => !found.has(id));
        if (missingLocs.length > 0) {
          throw new Error(`WO_BATCH_LOCATIONS_MISSING:${missingLocs.join(',')}`);
        }
        for (const row of locRes.rows) {
          if (row.warehouse_id) {
            warehouseByLocationId.set(row.id, row.warehouse_id);
          }
        }
        const missingWarehouseBindings = [
          ...consumeLinesOrdered
            .filter((line) => !warehouseByLocationId.get(line.fromLocationId))
            .map((line) => line.fromLocationId),
          ...produceLinesOrdered
            .filter((line) => !warehouseByLocationId.get(line.toLocationId))
            .map((line) => line.toLocationId)
        ];
        if (missingWarehouseBindings.length > 0) {
          throw new Error(
            `WO_BATCH_LOCATION_WAREHOUSE_MISSING:${Array.from(new Set(missingWarehouseBindings)).join(',')}`
          );
        }
        if (!isDisassembly) {
          for (const line of consumeLinesOrdered) {
            await assertWorkOrderRoutingLine({
              tenantId,
              context: workOrderRoutingContext(workOrder),
              componentItemId: line.componentItemId,
              consumeLocationId: line.fromLocationId,
              client
            });
          }
          for (const line of produceLinesOrdered) {
            await assertWorkOrderRoutingLine({
              tenantId,
              context: workOrderRoutingContext(workOrder),
              produceLocationId: line.toLocationId,
              client
            });
          }
        }
      }
      return [
        ...consumeLinesOrdered.map((line) => ({
          tenantId,
          warehouseId: warehouseByLocationId.get(line.fromLocationId) ?? '',
          itemId: line.componentItemId
        })),
        ...produceLinesOrdered.map((line) => ({
          tenantId,
          warehouseId: warehouseByLocationId.get(line.toLocationId) ?? '',
          itemId: line.outputItemId
        }))
      ];
    },
    execute: async ({ client }) => {
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
      }
      const isDisassembly = workOrder.kind === 'disassembly';
      const preparedConsumes: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: NormalizedBatchConsumeLine;
        canonicalFields: CanonicalMovementFields;
        reasonCode: string;
      }> = [];
      for (const line of consumeLinesOrdered) {
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.componentItemId,
          -line.quantity,
          line.uom,
          client
        );
        preparedConsumes.push({
          sourceLineId: `${line.componentItemId}:${line.fromLocationId}:${line.uom}:${line.quantity}`,
          warehouseId: warehouseByLocationId.get(line.fromLocationId) ?? '',
          line,
          canonicalFields,
          reasonCode: line.reasonCode ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue')
        });
      }
      const sortedConsumes = sortDeterministicMovementLines(preparedConsumes, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.fromLocationId,
        itemId: entry.line.componentItemId,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));

      const preparedProduces: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: NormalizedBatchProduceLine;
        canonicalFields: CanonicalMovementFields;
        reasonCode: string;
      }> = [];
      let producedTotal = 0;
      let producedCanonicalTotal = 0;
      for (const line of produceLinesOrdered) {
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.outputItemId,
          line.quantity,
          line.uom,
          client
        );
        producedTotal += line.quantity;
        producedCanonicalTotal += canonicalFields.quantityDeltaCanonical;
        preparedProduces.push({
          sourceLineId: `${line.outputItemId}:${line.toLocationId}:${line.uom}:${line.quantity}`,
          warehouseId: warehouseByLocationId.get(line.toLocationId) ?? '',
          line,
          canonicalFields,
          reasonCode: line.reasonCode ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion')
        });
      }
      const sortedProduces = sortDeterministicMovementLines(preparedProduces, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.toLocationId,
        itemId: entry.line.outputItemId,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));
      await assertWorkOrderExecutionInvariants({
        tenantId,
        workOrder,
        consumeLines: sortedConsumes.map((entry) => ({
          itemId: entry.line.componentItemId,
          locationId: entry.line.fromLocationId,
          uom: entry.canonicalFields.canonicalUom,
          quantity: Math.abs(entry.canonicalFields.quantityDeltaCanonical),
          reasonCode: entry.reasonCode
        })),
        produceLines: sortedProduces.map((entry) => ({
          itemId: entry.line.outputItemId,
          locationId: entry.line.toLocationId,
          uom: entry.canonicalFields.canonicalUom,
          quantity: entry.canonicalFields.quantityDeltaCanonical,
          reasonCode: entry.reasonCode
        })),
        client
      });
      if (existingBatchReplay) {
        return buildWorkOrderBatchReplayResult({
          tenantId,
          workOrderId: existingBatchReplay.workOrderId,
          executionId: existingBatchReplay.executionId,
          issueMovementId: existingBatchReplay.issueMovementId,
          receiveMovementId: existingBatchReplay.receiveMovementId,
          expectedIssueLineCount: sortedConsumes.length,
          expectedReceiveLineCount: sortedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey
        });
      }
      const executionId = uuidv4();
      assertManufacturingTransition({
        flow: 'report',
        currentState: 'planned_completion',
        allowedFrom: ['planned_completion'],
        targetState: 'reported_production',
        workOrderId,
        executionOrDocumentId: executionId
      });

      const issueId = uuidv4();
      const now = new Date();
      const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
      const validation = await validateSufficientStock(
        tenantId,
        occurredAt,
        consumeLinesOrdered.map((line) => ({
          warehouseId: warehouseByLocationId.get(line.fromLocationId) ?? '',
          itemId: line.componentItemId,
          locationId: line.fromLocationId,
          uom: line.uom,
          quantityToConsume: roundQuantity(line.quantity)
        })),
        {
          actorId: context.actor?.id ?? null,
          actorRole: context.actor?.role ?? null,
          overrideRequested: context.overrideRequested,
          overrideReason: context.overrideReason ?? null,
          overrideReference: `work_order_batch_issue:${issueId}`
        },
        { client }
      );

      const issueMovementId = uuidv4();
      const receiveMovementId = uuidv4();
      const plannedIssueMovementLines: Array<{
        preparedConsume: (typeof sortedConsumes)[number];
        issueCost: number | null;
        consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
      }> = [];
      for (const preparedConsume of sortedConsumes) {
        const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
        let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>>;
        try {
          consumptionPlan = await planCostLayerConsumption({
            tenant_id: tenantId,
            item_id: preparedConsume.line.componentItemId,
            location_id: preparedConsume.line.fromLocationId,
            quantity: canonicalQty,
            consumption_type: 'production_input',
            consumption_document_id: issueId,
            movement_id: issueMovementId,
            client
          });
        } catch {
          throw new Error('WO_WIP_COST_LAYERS_MISSING');
        }
        plannedIssueMovementLines.push({
          preparedConsume,
          issueCost: consumptionPlan.total_cost,
          consumptionPlan
        });
      }

      if (producedCanonicalTotal <= 0) {
        throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
      }
      const totalPlannedIssueCost = plannedIssueMovementLines.reduce(
        (sum, plannedLine) => sum + (plannedLine.issueCost ?? 0),
        0
      );
      const plannedReceiveMovementLines = sortedProduces.map((preparedProduce) => {
        const allocationRatio = preparedProduce.canonicalFields.quantityDeltaCanonical / producedCanonicalTotal;
        const allocatedCost = totalPlannedIssueCost * allocationRatio;
        const unitCost =
          preparedProduce.canonicalFields.quantityDeltaCanonical !== 0
            ? allocatedCost / preparedProduce.canonicalFields.quantityDeltaCanonical
            : null;
        return {
          preparedProduce,
          allocatedCost,
          unitCost
        };
      });

      const issueMovement = await persistInventoryMovement(client, {
        id: issueMovementId,
        tenantId,
        movementType: 'issue',
        status: 'posted',
        externalRef: isDisassembly
          ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
          : `work_order_batch_issue:${issueId}:${workOrderId}`,
        sourceType: 'work_order_batch_post_issue',
        sourceId: executionId,
        idempotencyKey: batchIdempotencyKey ? `${batchIdempotencyKey}:issue` : `wo-batch-issue-post:${executionId}`,
        occurredAt,
        postedAt: now,
        notes: data.notes ?? null,
        metadata: {
          workOrderId,
          workOrderNumber,
          ...(validation.overrideMetadata ?? {})
        },
        createdAt: now,
        updatedAt: now,
        lines: plannedIssueMovementLines.map(({ preparedConsume, issueCost }) => {
          const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
          const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
          const extendedCost = issueCost !== null ? -issueCost : null;
          return {
            warehouseId: preparedConsume.warehouseId,
            sourceLineId: preparedConsume.sourceLineId,
            itemId: preparedConsume.line.componentItemId,
            locationId: preparedConsume.line.fromLocationId,
            quantityDelta: preparedConsume.canonicalFields.quantityDeltaCanonical,
            uom: preparedConsume.canonicalFields.canonicalUom,
            quantityDeltaEntered: preparedConsume.canonicalFields.quantityDeltaEntered,
            uomEntered: preparedConsume.canonicalFields.uomEntered,
            quantityDeltaCanonical: preparedConsume.canonicalFields.quantityDeltaCanonical,
            canonicalUom: preparedConsume.canonicalFields.canonicalUom,
            uomDimension: preparedConsume.canonicalFields.uomDimension,
            unitCost,
            extendedCost,
            reasonCode: preparedConsume.reasonCode,
            lineNotes: preparedConsume.line.notes ?? null,
            createdAt: now
          };
        })
      });
      const receiveMovement = await persistInventoryMovement(client, {
        id: receiveMovementId,
        tenantId,
        movementType: 'receive',
        status: 'posted',
        externalRef: isDisassembly
          ? `work_order_disassembly_completion:${executionId}:${workOrderId}`
          : `work_order_batch_completion:${executionId}:${workOrderId}`,
        sourceType: 'work_order_batch_post_completion',
        sourceId: executionId,
        idempotencyKey: batchIdempotencyKey
          ? `${batchIdempotencyKey}:completion`
          : `wo-batch-completion-post:${executionId}`,
        occurredAt,
        postedAt: now,
        notes: data.notes ?? null,
        metadata: { workOrderId, workOrderNumber },
        createdAt: now,
        updatedAt: now,
        lines: plannedReceiveMovementLines.map(({ preparedProduce, allocatedCost, unitCost }) => ({
          warehouseId: preparedProduce.warehouseId,
          sourceLineId: preparedProduce.sourceLineId,
          itemId: preparedProduce.line.outputItemId,
          locationId: preparedProduce.line.toLocationId,
          quantityDelta: preparedProduce.canonicalFields.quantityDeltaCanonical,
          uom: preparedProduce.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedProduce.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedProduce.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedProduce.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedProduce.canonicalFields.canonicalUom,
          uomDimension: preparedProduce.canonicalFields.uomDimension,
          unitCost,
          extendedCost: allocatedCost,
          reasonCode: preparedProduce.reasonCode,
          lineNotes: preparedProduce.line.notes ?? null,
          createdAt: now
        }))
      });

      if (!issueMovement.created || !receiveMovement.created) {
        if (batchIdempotencyKey) {
          const replay = await findPostedBatchByIdempotencyKey(
            client,
            tenantId,
            batchIdempotencyKey,
            requestHash
          );
          if (replay) {
            return buildWorkOrderBatchReplayResult({
              tenantId,
              workOrderId,
              executionId: replay.executionId,
              issueMovementId: replay.issueMovementId,
              receiveMovementId: replay.receiveMovementId,
              expectedIssueLineCount: sortedConsumes.length,
              expectedReceiveLineCount: sortedProduces.length,
              client,
              idempotencyKey: batchIdempotencyKey
            });
          }
        }
        throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
          reason: !issueMovement.created
            ? 'issue_movement_already_exists_without_replayable_execution'
            : 'completion_movement_already_exists_without_replayable_execution',
          missingExecutionIds: [],
          hint: 'Retry with the same Idempotency-Key or contact admin'
        });
      }

      await client.query(
        `INSERT INTO work_order_material_issues (
            id, tenant_id, work_order_id, status, occurred_at, inventory_movement_id, notes, idempotency_key, created_at, updated_at
         ) VALUES ($1, $2, $3, 'posted', $4, $5, $6, $7, $8, $8)`,
        [
          issueId,
          tenantId,
          workOrderId,
          occurredAt,
          issueMovementId,
          data.notes ?? null,
          batchIdempotencyKey ? `${batchIdempotencyKey}:issue-doc` : null,
          now
        ]
      );
      for (let i = 0; i < consumeLinesOrdered.length; i += 1) {
        const line = consumeLinesOrdered[i];
        await client.query(
          `INSERT INTO work_order_material_issue_lines (
              id, tenant_id, work_order_material_issue_id, line_number, component_item_id, uom, quantity_issued, from_location_id, reason_code, notes, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            uuidv4(),
            tenantId,
            issueId,
            i + 1,
            line.componentItemId,
            line.uom,
            line.quantity,
            line.fromLocationId,
            line.reasonCode,
            line.notes ?? null,
            now
          ]
        );
      }

      let totalConsumedCost = 0;
      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const { preparedConsume, issueCost, consumptionPlan } of plannedIssueMovementLines) {
        const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: preparedConsume.line.componentItemId,
          location_id: preparedConsume.line.fromLocationId,
          quantity: canonicalQty,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: issueMovementId,
          client,
          plan: consumptionPlan
        });
        totalConsumedCost += issueCost ?? 0;
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedConsume.line.componentItemId,
            locationId: preparedConsume.line.fromLocationId,
            uom: preparedConsume.canonicalFields.canonicalUom,
            deltaOnHand: preparedConsume.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      await client.query(
        `INSERT INTO work_order_executions (
            id, tenant_id, work_order_id, occurred_at, status, consumption_movement_id, production_movement_id,
            notes, idempotency_key, idempotency_request_hash, idempotency_request_summary, created_at
         ) VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          executionId,
          tenantId,
          workOrderId,
          occurredAt,
          issueMovementId,
          receiveMovementId,
          data.notes ?? null,
          batchIdempotencyKey,
          batchIdempotencyKey ? requestHash : null,
          batchIdempotencyKey
            ? JSON.stringify({
              workOrderId,
              consumeLineCount: normalizedConsumes.length,
              produceLineCount: normalizedProduces.length,
              executionIds: [executionId]
            })
            : null,
          now
        ]
      );
      for (let i = 0; i < produceLinesOrdered.length; i += 1) {
        const line = produceLinesOrdered[i];
        await client.query(
          `INSERT INTO work_order_execution_lines (
              id, tenant_id, work_order_execution_id, line_type, item_id, uom, quantity, pack_size, from_location_id, to_location_id, reason_code, notes, created_at
           ) VALUES ($1, $2, $3, 'produce', $4, $5, $6, $7, NULL, $8, $9, $10, $11)`,
          [
            uuidv4(),
            tenantId,
            executionId,
            line.outputItemId,
            line.uom,
            line.quantity,
            line.packSize ?? null,
            line.toLocationId,
            line.reasonCode,
            line.notes ?? null,
            now
          ]
        );
      }

      const totalIssueCost = await allocateWipCostFromMovement(
        client,
        tenantId,
        executionId,
        issueMovementId,
        now
      );
      const wipUnitCostCanonical = totalIssueCost / producedCanonicalTotal;
      for (const { preparedProduce, allocatedCost, unitCost } of plannedReceiveMovementLines) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedProduce.line.outputItemId,
          location_id: preparedProduce.line.toLocationId,
          uom: preparedProduce.canonicalFields.canonicalUom,
          quantity: preparedProduce.canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost ?? 0,
          source_type: 'production',
          source_document_id: issueId,
          movement_id: receiveMovementId,
          notes: `Backflush production from work order ${workOrderId}`,
          client
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedProduce.line.outputItemId,
            locationId: preparedProduce.line.toLocationId,
            uom: preparedProduce.canonicalFields.canonicalUom,
            deltaOnHand: preparedProduce.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId,
        movementId: issueMovementId,
        valuationType: 'issue',
        valueDelta: totalConsumedCost,
        notes: `Work-order batch issue WIP valuation for execution ${executionId}`
      });
      const outputUomSet = new Set(
        sortedProduces.map((line) => line.canonicalFields.canonicalUom)
      );
      const outputCanonicalUom =
        outputUomSet.size === 1 ? sortedProduces[0]?.canonicalFields.canonicalUom ?? null : null;
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId,
        movementId: receiveMovementId,
        valuationType: 'report',
        valueDelta: -totalIssueCost,
        quantityCanonical: outputCanonicalUom ? producedCanonicalTotal : null,
        canonicalUom: outputCanonicalUom,
        notes: `Work-order production report WIP capitalization for execution ${executionId}`
      });
      await verifyWorkOrderWipIntegrity(client, tenantId, workOrderId);
      await consumeWorkOrderReservations(
        tenantId,
        workOrderId,
        consumeLinesOrdered.map((line) => ({
          componentItemId: line.componentItemId,
          locationId: line.fromLocationId,
          uom: line.uom,
          quantity: line.quantity
        })),
        client
      );

      const consumedTotal = consumeLinesOrdered.reduce((sum, line) => sum + line.quantity, 0);
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const progressQty = isDisassembly ? consumedTotal : producedTotal;
      const newCompleted = currentCompleted + progressQty;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const newStatus = nextStatusFromProgress({
        currentStatus: workOrder.status,
        plannedQuantity: planned,
        completedQuantity: newCompleted,
        scrappedQuantity: toNumber(workOrder.quantity_scrapped ?? 0)
      });

      projectionOps.push(async (projectionClient) => {
        await projectionClient.query(
          `UPDATE work_order_executions
              SET wip_total_cost = $1,
                  wip_unit_cost = $2,
                  wip_quantity_canonical = $3,
                  wip_cost_method = $4,
                  wip_costed_at = $5
            WHERE id = $6
              AND tenant_id = $7`,
          [
            totalIssueCost,
            wipUnitCostCanonical,
            producedCanonicalTotal,
            WIP_COST_METHOD,
            now,
            executionId,
            tenantId
          ]
        );
        await projectionClient.query(
          `UPDATE work_orders
              SET quantity_completed = $2,
                  status = $3,
                  completed_at = COALESCE(completed_at, $4),
                  wip_total_cost = COALESCE(wip_total_cost, 0) + $5,
                  wip_quantity_canonical = COALESCE(wip_quantity_canonical, 0) + $6,
                  wip_unit_cost = CASE
                    WHEN (COALESCE(wip_quantity_canonical, 0) + $6) > 0
                    THEN (COALESCE(wip_total_cost, 0) + $5) / (COALESCE(wip_quantity_canonical, 0) + $6)
                    ELSE NULL
                  END,
                  wip_cost_method = $7,
                  wip_costed_at = $8,
                  updated_at = $9
            WHERE id = $1
              AND tenant_id = $10`,
          [
            workOrderId,
            newCompleted,
            newStatus,
            completedAt,
            totalIssueCost,
            producedCanonicalTotal,
            WIP_COST_METHOD,
            now,
            now,
            tenantId
          ]
        );

        if (validation.overrideMetadata && context.actor) {
          await recordAuditLog(
            {
              tenantId,
              actorType: context.actor.type,
              actorId: context.actor.id ?? null,
              action: 'negative_override',
              entityType: 'inventory_movement',
              entityId: issueMovementId,
              occurredAt: now,
              metadata: {
                reason: validation.overrideMetadata.override_reason ?? null,
                workOrderId,
                executionId,
                reference: validation.overrideMetadata.override_reference ?? null,
                lines: consumeLinesOrdered.map((line) => ({
                  itemId: line.componentItemId,
                  locationId: line.fromLocationId,
                  uom: line.uom,
                  quantity: roundQuantity(line.quantity)
                }))
              }
            },
            projectionClient
          );
        }
      });

      return {
        responseBody: {
          workOrderId,
          executionId,
          issueMovementId,
          receiveMovementId,
          quantityCompleted: newCompleted,
          workOrderStatus: newStatus,
          idempotencyKey: batchIdempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(issueMovementId, batchIdempotencyKey),
          buildMovementPostedEvent(receiveMovementId, batchIdempotencyKey),
          buildWorkOrderProductionReportedEvent({
            executionId,
            workOrderId,
            issueMovementId,
            receiveMovementId,
            producerIdempotencyKey: batchIdempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}
