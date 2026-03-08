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
import { consumeCostLayers, createCostLayer } from './costLayers.service';
import { getCanonicalMovementFields, type CanonicalMovementFields } from './uomCanonical.service';
import { getWarehouseDefaultLocationId, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  createInventoryMovement,
  createInventoryMovementLine
} from '../domains/inventory';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema,
  workOrderReportProductionSchema,
  workOrderReportScrapSchema,
  workOrderVoidReportProductionSchema
} from '../schemas/workOrderExecution.schema';
import { transferInventory } from './transfers.service';
import {
  claimTransactionalIdempotency,
  finalizeTransactionalIdempotency,
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
  buildMovementPostedEvent,
  buildPostedDocumentReplayResult,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';

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

async function resolveWarehouseRootId(
  client: PoolClient | undefined,
  tenantId: string,
  warehouseRef?: string | null
): Promise<string | null> {
  const executor = client ? client.query.bind(client) : query;
  if (!warehouseRef) return null;
  const ref = warehouseRef.trim();
  if (!ref) return null;
  const res = await executor<{ id: string }>(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND type = 'warehouse'
        AND (id::text = $2 OR code = $2)
      ORDER BY id
      LIMIT 1`,
    [tenantId, ref]
  );
  return res.rows[0]?.id ?? null;
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
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
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

async function resolveRoutingFinalStepProduceLocation(
  tenantId: string,
  outputItemId: string,
  client?: PoolClient
): Promise<string | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<{ location_id: string | null }>(
    `WITH selected_routing AS (
       SELECT r.id
         FROM routings r
        WHERE r.tenant_id = $1
          AND r.item_id = $2
        ORDER BY
          CASE WHEN r.is_default THEN 0 ELSE 1 END,
          CASE
            WHEN r.status = 'active' THEN 0
            WHEN r.status = 'draft' THEN 1
            ELSE 2
          END,
          r.updated_at DESC,
          r.created_at DESC,
          r.id
        LIMIT 1
     )
     SELECT wc.location_id
       FROM selected_routing sr
       JOIN routing_steps rs
         ON rs.routing_id = sr.id
        AND rs.tenant_id = $1
       JOIN work_centers wc
         ON wc.id = rs.work_center_id
        AND wc.tenant_id = $1
      WHERE wc.location_id IS NOT NULL
      ORDER BY rs.sequence_number DESC
      LIMIT 1`,
    [tenantId, outputItemId]
  );
  return res.rows[0]?.location_id ?? null;
}

async function resolveRoutingFinalStepProduceLocationByRoutingId(
  tenantId: string,
  routingId: string,
  client?: PoolClient
): Promise<string | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<{ location_id: string | null }>(
    `SELECT wc.location_id
       FROM routing_steps rs
       JOIN work_centers wc
         ON wc.id = rs.work_center_id
        AND wc.tenant_id = $1
      WHERE rs.tenant_id = $1
        AND rs.routing_id = $2
        AND wc.location_id IS NOT NULL
      ORDER BY rs.sequence_number DESC
      LIMIT 1`,
    [tenantId, routingId]
  );
  return res.rows[0]?.location_id ?? null;
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

async function allocateWipCostFromWorkOrderIssues(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  executionId: string,
  allocatedAt: Date
): Promise<number> {
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
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
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
      if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
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
      if (issueState === 'posted_issue') {
        return buildWorkOrderIssueReplayResult({
          tenantId,
          workOrderId,
          issueId,
          movementId: issue.inventory_movement_id!,
          client
        });
      }

      const isDisassembly = workOrder.kind === 'disassembly';
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

      const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
      const movement = await createInventoryMovement(client, {
        id: uuidv4(),
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
        updatedAt: now
      });

      if (!movement.created) {
        return buildWorkOrderIssueReplayResult({
          tenantId,
          workOrderId,
          issueId,
          movementId: movement.id,
          client
        });
      }

      const preparedLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: WorkOrderMaterialIssueLineRow;
        canonicalFields: CanonicalMovementFields;
        unitCost: number | null;
        extendedCost: number | null;
        reasonCode: string;
      }> = [];
      let totalIssueCost = 0;
      const issuedTotal = linesForPosting.reduce(
        (sum, line) => sum + toNumber(line.quantity_issued),
        0
      );

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
        const canonicalQty = Math.abs(canonicalFields.quantityDeltaCanonical);
        let issueCost: number | null = null;
        try {
          const consumption = await consumeCostLayers({
            tenant_id: tenantId,
            item_id: line.component_item_id,
            location_id: line.from_location_id,
            quantity: canonicalQty,
            consumption_type: 'production_input',
            consumption_document_id: issueId,
            movement_id: movement.id,
            client
          });
          issueCost = consumption.total_cost;
        } catch {
          throw new Error('WO_WIP_COST_LAYERS_MISSING');
        }
        totalIssueCost += issueCost ?? 0;
        preparedLines.push({
          sourceLineId: line.id,
          warehouseId: warehouseIdsByLocation.get(line.from_location_id) ?? '',
          line,
          canonicalFields,
          unitCost: issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null,
          extendedCost: issueCost !== null ? -issueCost : null,
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

      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const preparedLine of sortedMovementLines) {
        await createInventoryMovementLine(client, {
          tenantId,
          movementId: movement.id,
          itemId: preparedLine.line.component_item_id,
          locationId: preparedLine.line.from_location_id,
          quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedLine.canonicalFields.canonicalUom,
          uomDimension: preparedLine.canonicalFields.uomDimension,
          unitCost: preparedLine.unitCost,
          extendedCost: preparedLine.extendedCost,
          reasonCode: preparedLine.reasonCode,
          lineNotes:
            preparedLine.line.notes ?? `Work order issue ${issueId} line ${preparedLine.line.line_number}`
        });
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
        movementId: movement.id,
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
          [movement.id, now, issueId, tenantId]
        );

        if (workOrder!.status === 'draft') {
          await projectionClient.query(
            `UPDATE work_orders
                SET status = 'in_progress',
                    updated_at = $2
              WHERE id = $1
                AND tenant_id = $3`,
            [workOrderId, now, tenantId]
          );
        }

        if (isDisassembly) {
          const currentCompleted = toNumber(workOrder!.quantity_completed ?? 0);
          const newCompleted = currentCompleted + issuedTotal;
          const planned = toNumber(workOrder!.quantity_planned);
          const completedAt = newCompleted >= planned ? now : null;
          const nextStatus =
            newCompleted >= planned
              ? 'completed'
              : workOrder!.status === 'draft'
                ? 'in_progress'
                : workOrder!.status;
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
              entityId: movement.id,
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
            inventory_movement_id: movement.id,
            updated_at: now.toISOString()
          },
          linesForPosting
        ),
        responseStatus: 200,
        events: [
          buildMovementPostedEvent(movement.id),
          buildWorkOrderIssuePostedEvent({
            issueId,
            workOrderId,
            movementId: movement.id
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
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
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
      if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
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
      if (completionState === 'posted_completion') {
        return buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: execution.production_movement_id!,
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

      const isDisassembly = workOrder.kind === 'disassembly';
      const now = new Date();
      const movement = await createInventoryMovement(client, {
        id: uuidv4(),
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
        updatedAt: now
      });

      if (!movement.created) {
        return buildWorkOrderCompletionReplayResult({
          tenantId,
          workOrderId,
          completionId,
          movementId: movement.id,
          client
        });
      }

      const preparedLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: WorkOrderExecutionLineRow;
        canonicalFields: CanonicalMovementFields;
        unitCost: number | null;
        extendedCost: number;
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
          unitCost: null,
          extendedCost: 0
        });
      }

      if (totalProducedCanonical <= 0) {
        throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
      }

      const totalIssueCost = await allocateWipCostFromWorkOrderIssues(
        client,
        tenantId,
        workOrderId,
        completionId,
        now
      );
      const wipUnitCostCanonical = totalIssueCost / totalProducedCanonical;

      for (const preparedLine of preparedLines) {
        const allocationRatio = preparedLine.canonicalFields.quantityDeltaCanonical / totalProducedCanonical;
        const allocatedCost = totalIssueCost * allocationRatio;
        preparedLine.extendedCost = allocatedCost;
        preparedLine.unitCost =
          preparedLine.canonicalFields.quantityDeltaCanonical !== 0
            ? allocatedCost / preparedLine.canonicalFields.quantityDeltaCanonical
            : null;
      }

      const sortedMovementLines = sortDeterministicMovementLines(preparedLines, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.to_location_id!,
        itemId: entry.line.item_id,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));

      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const preparedLine of sortedMovementLines) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedLine.line.item_id,
          location_id: preparedLine.line.to_location_id!,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantity: preparedLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: preparedLine.unitCost ?? 0,
          source_type: 'production',
          source_document_id: completionId,
          movement_id: movement.id,
          notes: `Production output from work order ${workOrderId}`,
          client
        });

        await createInventoryMovementLine(client, {
          tenantId,
          movementId: movement.id,
          itemId: preparedLine.line.item_id,
          locationId: preparedLine.line.to_location_id!,
          quantityDelta: preparedLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedLine.canonicalFields.canonicalUom,
          uomDimension: preparedLine.canonicalFields.uomDimension,
          unitCost: preparedLine.unitCost,
          extendedCost: preparedLine.extendedCost,
          reasonCode:
            preparedLine.line.reason_code
            ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion'),
          lineNotes: preparedLine.line.notes ?? `Work order completion ${completionId}`
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

      const completionUomSet = new Set(
        preparedLines.map((line) => line.canonicalFields.canonicalUom)
      );
      const completionCanonicalUom =
        completionUomSet.size === 1 ? preparedLines[0]?.canonicalFields.canonicalUom ?? null : null;
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: completionId,
        movementId: movement.id,
        valuationType: 'completion',
        valueDelta: -totalIssueCost,
        quantityCanonical: completionCanonicalUom ? totalProducedCanonical : null,
        canonicalUom: completionCanonicalUom,
        notes: `Work-order completion WIP capitalization for execution ${completionId}`
      });

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
            movement.id,
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
          const newStatus =
            newCompleted >= planned
              ? 'completed'
              : workOrder!.status === 'draft'
                ? 'in_progress'
                : workOrder!.status;
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
        } else if (workOrder!.status === 'draft') {
          await projectionClient.query(
            `UPDATE work_orders
                SET status = 'in_progress',
                    wip_total_cost = COALESCE(wip_total_cost, 0) + $2,
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
            production_movement_id: movement.id,
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
          buildMovementPostedEvent(movement.id),
          buildWorkOrderCompletionPostedEvent({
            executionId: completionId,
            workOrderId,
            movementId: movement.id
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
    remainingToComplete: roundQuantity(Math.max(0, planned - completed)),
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
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovementIds: [params.movementId],
    client: params.client,
    fetchAggregateView: () =>
      fetchWorkOrderIssue(params.tenantId, params.workOrderId, params.issueId, params.client),
    aggregateNotFoundError: new Error('WO_ISSUE_NOT_FOUND'),
    movementNotReadyError: (movementId, readiness) =>
      domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        flow: 'issue',
        issueId: params.issueId,
        movementId,
        reason: readiness.movementExists
          ? 'authoritative_movement_missing_lines'
          : 'authoritative_movement_missing'
      }),
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
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovementIds: [params.movementId],
    client: params.client,
    fetchAggregateView: () =>
      fetchWorkOrderCompletion(params.tenantId, params.workOrderId, params.completionId, params.client),
    aggregateNotFoundError: new Error('WO_COMPLETION_NOT_FOUND'),
    movementNotReadyError: (movementId, readiness) =>
      domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        flow: 'completion',
        completionId: params.completionId,
        movementId,
        reason: readiness.movementExists
          ? 'authoritative_movement_missing_lines'
          : 'authoritative_movement_missing'
      }),
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
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovementIds: [params.issueMovementId, params.receiveMovementId],
    client: params.client,
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
    movementNotReadyError: (movementId, readiness) =>
      domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        flow: 'report',
        executionId: params.executionId,
        movementId,
        reason: readiness.movementExists
          ? 'authoritative_movement_missing_lines'
          : 'authoritative_movement_missing'
      }),
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
  client: PoolClient;
  idempotencyKey?: string | null;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovementIds: [
      params.componentReturnMovementId,
      params.outputReversalMovementId
    ],
    client: params.client,
    fetchAggregateView: async () => ({
      workOrderId: params.workOrderId,
      workOrderExecutionId: params.executionId,
      componentReturnMovementId: params.componentReturnMovementId,
      outputReversalMovementId: params.outputReversalMovementId,
      idempotencyKey: params.idempotencyKey ?? null,
      replayed: true
    }),
    aggregateNotFoundError: new Error('WO_VOID_EXECUTION_NOT_FOUND'),
    movementNotReadyError: (movementId, readiness) =>
      domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        flow: 'reversal',
        executionId: params.executionId,
        movementId,
        reason: readiness.movementExists
          ? 'authoritative_movement_missing_lines'
          : 'authoritative_movement_missing'
      }),
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

  const routingSnapshotProduceLocationId = workOrder.produceToLocationIdSnapshot ?? null;
  const runtimeRoutingProduceLocationId = workOrder.routingId
    ? await resolveRoutingFinalStepProduceLocationByRoutingId(tenantId, workOrder.routingId)
    : await resolveRoutingFinalStepProduceLocation(tenantId, workOrder.outputItemId);
  const warehouseFromRoutingSnapshot = routingSnapshotProduceLocationId
    ? await resolveWarehouseIdForLocation(tenantId, routingSnapshotProduceLocationId)
    : null;
  const warehouseFromRoutingStep = runtimeRoutingProduceLocationId
    ? await resolveWarehouseIdForLocation(tenantId, runtimeRoutingProduceLocationId)
    : null;
  const effectiveSnapshotProduceLocationId = warehouseFromRoutingSnapshot ? routingSnapshotProduceLocationId : null;
  const effectiveRuntimeRoutingProduceLocationId = warehouseFromRoutingStep ? runtimeRoutingProduceLocationId : null;
  const warehouseFromInput = await resolveWarehouseRootId(undefined, tenantId, data.warehouseId ?? null);
  const warehouseFromProduceDefault = workOrder.defaultProduceLocationId
    ? await resolveWarehouseIdForLocation(tenantId, workOrder.defaultProduceLocationId)
    : null;
  const warehouseFromConsumeDefault = workOrder.defaultConsumeLocationId
    ? await resolveWarehouseIdForLocation(tenantId, workOrder.defaultConsumeLocationId)
    : null;
  const warehouseId =
    warehouseFromInput ??
    warehouseFromRoutingSnapshot ??
    warehouseFromRoutingStep ??
    warehouseFromProduceDefault ??
    warehouseFromConsumeDefault;
  if (!warehouseId) {
    throw new Error('WO_REPORT_WAREHOUSE_REQUIRED');
  }

  const consumeLocationId = await getWarehouseDefaultLocationId(tenantId, warehouseId, 'SELLABLE');
  const produceLocationId =
    effectiveSnapshotProduceLocationId ??
    effectiveRuntimeRoutingProduceLocationId ??
    workOrder.defaultProduceLocationId ??
    await getWarehouseDefaultLocationId(tenantId, warehouseId, 'QA');
  if (!consumeLocationId || !produceLocationId) {
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

  const consumeLines = requirements.lines
    .map((line) => {
      const override = overrides.get(line.componentItemId);
      const quantity = override ? override.quantity : roundQuantity(toNumber(line.quantityRequired));
      if (quantity < 0) {
        throw new Error('WO_REPORT_OVERRIDE_NEGATIVE_COMPONENT_QTY');
      }
      if (quantity === 0) {
        return null;
      }
      return {
        componentItemId: line.componentItemId,
        fromLocationId: consumeLocationId,
        uom: override?.uom ?? line.uom,
        quantity,
        reasonCode: override ? 'work_order_backflush_override' : 'work_order_backflush',
        notes: override?.reason ?? undefined
      };
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);

  if (consumeLines.length === 0) {
    throw new Error('WO_REPORT_NO_COMPONENT_CONSUMPTION');
  }
  if (Array.isArray(data.inputLots) && data.inputLots.length > 0) {
    const consumableComponentIds = new Set(consumeLines.map((line) => line.componentItemId));
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
        consumeLines,
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

      const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
      if (existingPair) {
        return buildWorkOrderVoidReplayResult({
          tenantId,
          workOrderId,
          executionId: execution.id,
          componentReturnMovementId: existingPair.componentReturnMovementId,
          outputReversalMovementId: existingPair.outputReversalMovementId,
          client,
          idempotencyKey
        });
      }

      const now = new Date();
      const outputMovement = await createInventoryMovement(client, {
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
        updatedAt: now
      });
      const componentMovement = await createInventoryMovement(client, {
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
        updatedAt: now
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
            client,
            idempotencyKey
          });
        }
        throw new Error('WO_VOID_INCOMPLETE');
      }

      const projectionOps: InventoryCommandProjectionOp[] = [];
      let totalOutputReversalCost = 0;
      let totalComponentReturnCost = 0;

      const preparedOutputLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: MovementLineScopeRow;
        canonicalFields: CanonicalMovementFields;
        unitCost: number | null;
        extendedCost: number;
      }> = [];
      for (const line of outputLines) {
        const quantityToReverse = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          -quantityToReverse,
          line.balance_uom,
          client
        );
        const canonicalQty = Math.abs(canonicalFields.quantityDeltaCanonical);
        const consumption = await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.location_id,
          quantity: canonicalQty,
          consumption_type: 'scrap',
          consumption_document_id: execution.id,
          movement_id: outputMovement.id,
          client,
          notes: `work_order_void_output:${execution.id}`
        });
        const unitCost = canonicalQty > 0 ? consumption.total_cost / canonicalQty : null;
        const extendedCost = -consumption.total_cost;
        totalOutputReversalCost += consumption.total_cost;
        preparedOutputLines.push({
          sourceLineId: `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReverse}`,
          warehouseId: line.warehouse_id ?? '',
          line,
          canonicalFields,
          unitCost,
          extendedCost
        });
      }

      const sortedOutputLines = sortDeterministicMovementLines(preparedOutputLines, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.location_id,
        itemId: entry.line.item_id,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));
      for (const preparedOutputLine of sortedOutputLines) {
        await createInventoryMovementLine(client, {
          tenantId,
          movementId: outputMovement.id,
          itemId: preparedOutputLine.line.item_id,
          locationId: preparedOutputLine.line.location_id,
          quantityDelta: preparedOutputLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedOutputLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedOutputLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedOutputLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedOutputLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedOutputLine.canonicalFields.canonicalUom,
          uomDimension: preparedOutputLine.canonicalFields.uomDimension,
          unitCost: preparedOutputLine.unitCost,
          extendedCost: preparedOutputLine.extendedCost,
          reasonCode: 'work_order_void_output',
          lineNotes: `Void output reversal for work order execution ${execution.id}`
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedOutputLine.line.item_id,
            locationId: preparedOutputLine.line.location_id,
            uom: preparedOutputLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedOutputLine.canonicalFields.quantityDeltaCanonical
          })
        );
      }

      const preparedComponentLines: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: MovementLineScopeRow;
        canonicalFields: CanonicalMovementFields;
        unitCost: number;
        extendedCost: number;
      }> = [];
      for (const line of componentLines) {
        const quantityToReturn = Math.abs(roundQuantity(toNumber(line.qty_canonical)));
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.item_id,
          quantityToReturn,
          line.balance_uom,
          client
        );
        const unitCost = movementLineUnitCost(line);
        const extendedCost = roundQuantity(canonicalFields.quantityDeltaCanonical * unitCost);
        totalComponentReturnCost += extendedCost;
        preparedComponentLines.push({
          sourceLineId: `${line.item_id}:${line.location_id}:${line.balance_uom}:${quantityToReturn}`,
          warehouseId: line.warehouse_id ?? '',
          line,
          canonicalFields,
          unitCost,
          extendedCost
        });
      }

      const sortedComponentLines = sortDeterministicMovementLines(preparedComponentLines, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.location_id,
        itemId: entry.line.item_id,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));
      for (const preparedComponentLine of sortedComponentLines) {
        await createInventoryMovementLine(client, {
          tenantId,
          movementId: componentMovement.id,
          itemId: preparedComponentLine.line.item_id,
          locationId: preparedComponentLine.line.location_id,
          quantityDelta: preparedComponentLine.canonicalFields.quantityDeltaCanonical,
          uom: preparedComponentLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedComponentLine.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedComponentLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedComponentLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedComponentLine.canonicalFields.canonicalUom,
          uomDimension: preparedComponentLine.canonicalFields.uomDimension,
          unitCost: preparedComponentLine.unitCost,
          extendedCost: preparedComponentLine.extendedCost,
          reasonCode: 'work_order_void_component_return',
          lineNotes: `Void component return for work order execution ${execution.id}`
        });
        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: preparedComponentLine.line.item_id,
            locationId: preparedComponentLine.line.location_id,
            uom: preparedComponentLine.canonicalFields.canonicalUom,
            deltaOnHand: preparedComponentLine.canonicalFields.quantityDeltaCanonical
          })
        );
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedComponentLine.line.item_id,
          location_id: preparedComponentLine.line.location_id,
          uom: preparedComponentLine.canonicalFields.canonicalUom,
          quantity: preparedComponentLine.canonicalFields.quantityDeltaCanonical,
          unit_cost: preparedComponentLine.unitCost,
          source_type: 'adjustment',
          source_document_id: execution.id,
          movement_id: componentMovement.id,
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
        movementId: outputMovement.id,
        valuationType: 'reversal_to_wip',
        valueDelta: totalOutputReversalCost,
        reversalOfValuationRecordId: originalReportValuation?.id ?? null,
        notes: `Work-order reversal moves finished-goods value back into WIP for execution ${execution.id}`
      });
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: execution.id,
        movementId: componentMovement.id,
        valuationType: 'reversal_from_wip',
        valueDelta: -totalComponentReturnCost,
        reversalOfValuationRecordId: originalIssueValuation?.id ?? null,
        notes: `Work-order reversal returns component value out of WIP for execution ${execution.id}`
      });

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
              outputReversalMovementId: outputMovement.id,
              componentReturnMovementId: componentMovement.id,
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
          componentReturnMovementId: componentMovement.id,
          outputReversalMovementId: outputMovement.id,
          idempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(componentMovement.id, idempotencyKey),
          buildMovementPostedEvent(outputMovement.id, idempotencyKey),
          buildWorkOrderProductionReversedEvent({
            executionId: execution.id,
            workOrderId,
            componentReturnMovementId: componentMovement.id,
            outputReversalMovementId: outputMovement.id,
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

  return withTransactionRetry(async (client) => {
    if (idempotencyKey && idempotencyRequestHash) {
      const claim = await claimTransactionalIdempotency<WorkOrderScrapReportResult>(client, {
        tenantId,
        key: idempotencyKey,
        endpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_SCRAP,
        requestHash: idempotencyRequestHash
      });
      if (claim.replayed) {
        return {
          ...claim.responseBody,
          idempotencyKey,
          replayed: true
        };
      }
    }

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
    const execution = executionRes.rows[0];
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
    const itemId = data.outputItemId ?? outputItemId;
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
    const sourceLocationId = qaSource.location_id;
    const warehouseId = qaSource.warehouse_id;
    const scrapLocationId = await getWarehouseDefaultLocationId(tenantId, warehouseId, 'SCRAP', client);
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

    const sourceId = idempotencyKey ? `idempotency:${idempotencyKey}` : `execution:${execution.id}:${uuidv4()}`;
    const transfer = await transferInventory(
      {
        tenantId,
        sourceLocationId,
        destinationLocationId: scrapLocationId,
        itemId,
        quantity,
        uom: data.uom,
        sourceType: WORK_ORDER_SCRAP_SOURCE_TYPE,
        sourceId,
        movementType: 'transfer',
        reasonCode,
        notes: data.notes ?? `Work-order scrap for execution ${execution.id}`,
        occurredAt,
        actorId: actor.id ?? null,
        idempotencyKey
      },
      client
    );

    const response: WorkOrderScrapReportResult = {
      workOrderId,
      workOrderExecutionId: execution.id,
      scrapMovementId: transfer.movementId,
      itemId,
      quantity,
      uom: data.uom,
      idempotencyKey,
      replayed: !transfer.created
    };
    if (idempotencyKey) {
      await finalizeTransactionalIdempotency(client, {
        tenantId,
        key: idempotencyKey,
        responseStatus: response.replayed ? 200 : 201,
        responseBody: response
      });
    }
    return response;
  }, WORK_ORDER_POST_RETRY_OPTIONS);
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
      if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
        throw new Error('WO_INVALID_STATE');
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
        const locationById = new Map(locRes.rows.map((row) => [row.id, row]));
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
            const sourceLocation = locationById.get(line.fromLocationId);
            if (!sourceLocation || sourceLocation.is_sellable !== true) {
              throw domainError('MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE', {
                workOrderId,
                locationId: line.fromLocationId,
                componentItemId: line.componentItemId,
                role: sourceLocation?.role ?? null,
                isSellable: sourceLocation?.is_sellable ?? null
              });
            }
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
      if (existingBatchReplay) {
        return buildWorkOrderBatchReplayResult({
          tenantId,
          workOrderId: existingBatchReplay.workOrderId,
          executionId: existingBatchReplay.executionId,
          issueMovementId: existingBatchReplay.issueMovementId,
          receiveMovementId: existingBatchReplay.receiveMovementId,
          client,
          idempotencyKey: batchIdempotencyKey
        });
      }
      if (!workOrder) {
        throw new Error('WO_NOT_FOUND');
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

      const isDisassembly = workOrder.kind === 'disassembly';
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

      const issueMovement = await createInventoryMovement(client, {
        id: uuidv4(),
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
        updatedAt: now
      });
      const receiveMovement = await createInventoryMovement(client, {
        id: uuidv4(),
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
        updatedAt: now
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
          issueMovement.id,
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

      const preparedConsumes: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: NormalizedBatchConsumeLine;
        canonicalFields: CanonicalMovementFields;
        unitCost: number | null;
        extendedCost: number | null;
        reasonCode: string;
      }> = [];
      let totalConsumedCost = 0;
      for (const line of consumeLinesOrdered) {
        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          line.componentItemId,
          -line.quantity,
          line.uom,
          client
        );
        const canonicalQty = Math.abs(canonicalFields.quantityDeltaCanonical);
        let issueCost: number | null = null;
        try {
          const consumption = await consumeCostLayers({
            tenant_id: tenantId,
            item_id: line.componentItemId,
            location_id: line.fromLocationId,
            quantity: canonicalQty,
            consumption_type: 'production_input',
            consumption_document_id: issueId,
            movement_id: issueMovement.id,
            client
          });
          issueCost = consumption.total_cost;
        } catch {
          throw new Error('WO_WIP_COST_LAYERS_MISSING');
        }
        totalConsumedCost += issueCost ?? 0;
        preparedConsumes.push({
          sourceLineId: `${line.componentItemId}:${line.fromLocationId}:${line.uom}:${line.quantity}`,
          warehouseId: warehouseByLocationId.get(line.fromLocationId) ?? '',
          line,
          canonicalFields,
          unitCost: issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null,
          extendedCost: issueCost !== null ? -issueCost : null,
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

      const projectionOps: InventoryCommandProjectionOp[] = [];
      for (const preparedConsume of sortedConsumes) {
        await createInventoryMovementLine(client, {
          tenantId,
          movementId: issueMovement.id,
          itemId: preparedConsume.line.componentItemId,
          locationId: preparedConsume.line.fromLocationId,
          quantityDelta: preparedConsume.canonicalFields.quantityDeltaCanonical,
          uom: preparedConsume.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedConsume.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedConsume.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedConsume.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedConsume.canonicalFields.canonicalUom,
          uomDimension: preparedConsume.canonicalFields.uomDimension,
          unitCost: preparedConsume.unitCost,
          extendedCost: preparedConsume.extendedCost,
          reasonCode: preparedConsume.reasonCode,
          lineNotes: preparedConsume.line.notes ?? null
        });
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
          issueMovement.id,
          receiveMovement.id,
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

      const preparedProduces: Array<{
        sourceLineId: string;
        warehouseId: string;
        line: NormalizedBatchProduceLine;
        canonicalFields: CanonicalMovementFields;
        unitCost: number | null;
        extendedCost: number;
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
          unitCost: null,
          extendedCost: 0
        });
      }

      if (producedCanonicalTotal <= 0) {
        throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
      }

      const totalIssueCost = await allocateWipCostFromMovement(
        client,
        tenantId,
        executionId,
        issueMovement.id,
        now
      );
      const wipUnitCostCanonical = totalIssueCost / producedCanonicalTotal;
      for (const preparedProduce of preparedProduces) {
        const allocationRatio = preparedProduce.canonicalFields.quantityDeltaCanonical / producedCanonicalTotal;
        const allocatedCost = totalIssueCost * allocationRatio;
        preparedProduce.extendedCost = allocatedCost;
        preparedProduce.unitCost =
          preparedProduce.canonicalFields.quantityDeltaCanonical !== 0
            ? allocatedCost / preparedProduce.canonicalFields.quantityDeltaCanonical
            : null;
      }

      const sortedProduces = sortDeterministicMovementLines(preparedProduces, (entry) => ({
        tenantId,
        warehouseId: entry.warehouseId,
        locationId: entry.line.toLocationId,
        itemId: entry.line.outputItemId,
        canonicalUom: entry.canonicalFields.canonicalUom,
        sourceLineId: entry.sourceLineId
      }));

      for (const preparedProduce of sortedProduces) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: preparedProduce.line.outputItemId,
          location_id: preparedProduce.line.toLocationId,
          uom: preparedProduce.canonicalFields.canonicalUom,
          quantity: preparedProduce.canonicalFields.quantityDeltaCanonical,
          unit_cost: preparedProduce.unitCost ?? 0,
          source_type: 'production',
          source_document_id: issueId,
          movement_id: receiveMovement.id,
          notes: `Backflush production from work order ${workOrderId}`,
          client
        });
        await createInventoryMovementLine(client, {
          tenantId,
          movementId: receiveMovement.id,
          itemId: preparedProduce.line.outputItemId,
          locationId: preparedProduce.line.toLocationId,
          quantityDelta: preparedProduce.canonicalFields.quantityDeltaCanonical,
          uom: preparedProduce.canonicalFields.canonicalUom,
          quantityDeltaEntered: preparedProduce.canonicalFields.quantityDeltaEntered,
          uomEntered: preparedProduce.canonicalFields.uomEntered,
          quantityDeltaCanonical: preparedProduce.canonicalFields.quantityDeltaCanonical,
          canonicalUom: preparedProduce.canonicalFields.canonicalUom,
          uomDimension: preparedProduce.canonicalFields.uomDimension,
          unitCost: preparedProduce.unitCost,
          extendedCost: preparedProduce.extendedCost,
          reasonCode:
            preparedProduce.line.reasonCode
            ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion'),
          lineNotes: preparedProduce.line.notes ?? null
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
        movementId: issueMovement.id,
        valuationType: 'issue',
        valueDelta: totalConsumedCost,
        notes: `Work-order batch issue WIP valuation for execution ${executionId}`
      });
      const outputUomSet = new Set(
        preparedProduces.map((line) => line.canonicalFields.canonicalUom)
      );
      const outputCanonicalUom =
        outputUomSet.size === 1 ? preparedProduces[0]?.canonicalFields.canonicalUom ?? null : null;
      await createWorkOrderWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId,
        movementId: receiveMovement.id,
        valuationType: 'report',
        valueDelta: -totalIssueCost,
        quantityCanonical: outputCanonicalUom ? producedCanonicalTotal : null,
        canonicalUom: outputCanonicalUom,
        notes: `Work-order production report WIP capitalization for execution ${executionId}`
      });

      const consumedTotal = consumeLinesOrdered.reduce((sum, line) => sum + line.quantity, 0);
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const progressQty = isDisassembly ? consumedTotal : producedTotal;
      const newCompleted = currentCompleted + progressQty;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const newStatus =
        newCompleted >= planned
          ? 'completed'
          : workOrder.status === 'draft'
            ? 'in_progress'
            : workOrder.status;

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
              entityId: issueMovement.id,
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
          issueMovementId: issueMovement.id,
          receiveMovementId: receiveMovement.id,
          quantityCompleted: newCompleted,
          workOrderStatus: newStatus,
          idempotencyKey: batchIdempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          buildMovementPostedEvent(issueMovement.id, batchIdempotencyKey),
          buildMovementPostedEvent(receiveMovement.id, batchIdempotencyKey),
          buildWorkOrderProductionReportedEvent({
            executionId,
            workOrderId,
            issueMovementId: issueMovement.id,
            receiveMovementId: receiveMovement.id,
            producerIdempotencyKey: batchIdempotencyKey
          })
        ],
        projectionOps
      };
    }
  });
}
