import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { createHash } from 'crypto';
import { query, withTransaction } from '../db';
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
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildInventoryBalanceProjectionOp,
  sortDeterministicMovementLines
} from '../modules/platform/application/inventoryMutationSupport';
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
import * as movementPlanner from './inventoryMovementPlanner';
import * as replayEngine from './inventoryReplayEngine';
import * as statePolicy from './inventoryStatePolicy';
import * as eventFactory from './inventoryEventFactory';
import * as wipEngine from './wipAccountingEngine';
import * as projectionEngine from './inventoryProjectionEngine';
import * as lotTraceability from './lotTraceabilityEngine';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;
type WorkOrderReportProductionInput = z.infer<typeof workOrderReportProductionSchema>;
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

export async function verifyWorkOrderWipIntegrityForClose(
  tenantId: string,
  workOrderId: string,
  client?: PoolClient
) {
  if (client) {
    await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
    return;
  }
  await withTransaction(async (tx) => {
    await wipEngine.verifyWipIntegrity(tx, tenantId, workOrderId);
  });
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
      if ((existing.rowCount ?? 0) > 0) {
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
      await ensureWorkOrderReservationsReady(tenantId, workOrderId, client);
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
      const occurredAt = new Date(issue.occurred_at);
      const baseIssueMovement = movementPlanner.buildIssueMovement({
        header: {
          id: issue.inventory_movement_id ?? uuidv4(),
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
          postedAt: occurredAt,
          notes: issue.notes ?? null,
          metadata: null,
          createdAt: occurredAt,
          updatedAt: occurredAt
        },
        lines: sortedMovementLines.map((preparedLine) => ({
          sourceLineId: preparedLine.sourceLineId,
          warehouseId: preparedLine.warehouseId,
          itemId: preparedLine.line.component_item_id,
          locationId: preparedLine.line.from_location_id,
          canonicalFields: preparedLine.canonicalFields,
          reasonCode: preparedLine.reasonCode,
          lineNotes:
            preparedLine.line.notes ?? `Work order issue ${issueId} line ${preparedLine.line.line_number}`
        }))
      });
      if (issueState === 'posted_issue') {
        return replayEngine.replayIssue({
          tenantId,
          workOrderId,
          issueId,
          movementId: issue.inventory_movement_id!,
          expectedLineCount: baseIssueMovement.expectedLineCount,
          expectedDeterministicHash: baseIssueMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderIssue(tenantId, workOrderId, issueId, client)
        });
      }

      statePolicy.assertManufacturingTransition({
        flow: 'issue',
        currentState: issueState,
        allowedFrom: ['planned_issue'],
        targetState: 'posted_issue',
        workOrderId,
        executionOrDocumentId: issueId
      });

      const now = new Date();
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

      const plannedIssueMovement = movementPlanner.buildIssueMovement({
        header: {
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
          updatedAt: now
        },
        lines: plannedMovementLines.map(({ preparedLine, issueCost }) => {
          const canonicalQty = Math.abs(preparedLine.canonicalFields.quantityDeltaCanonical);
          const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
          const extendedCost = issueCost !== null ? -issueCost : null;
          return {
            sourceLineId: preparedLine.sourceLineId,
            warehouseId: preparedLine.warehouseId,
            itemId: preparedLine.line.component_item_id,
            locationId: preparedLine.line.from_location_id,
            canonicalFields: preparedLine.canonicalFields,
            reasonCode: preparedLine.reasonCode,
            lineNotes:
              preparedLine.line.notes ?? `Work order issue ${issueId} line ${preparedLine.line.line_number}`,
            unitCost,
            extendedCost
          };
        })
      });
      const movement = await persistInventoryMovement(client, plannedIssueMovement.persistInput);

      if (!movement.created) {
        return replayEngine.replayIssue({
          tenantId,
          workOrderId,
          issueId,
          movementId: movement.movementId,
          expectedLineCount: plannedIssueMovement.expectedLineCount,
          expectedDeterministicHash: plannedIssueMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderIssue(tenantId, workOrderId, issueId, client)
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

      await wipEngine.createWipValuationRecord(client, {
        tenantId,
        workOrderId,
        executionId: null,
        movementId: movement.movementId,
        valuationType: 'issue',
        valueDelta: totalIssueCost,
        notes: `Work-order issue WIP valuation for issue ${issueId}`
      });
      await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
      await consumeWorkOrderReservations(
        tenantId,
        workOrderId,
        linesForPosting.map((line) => ({
          componentItemId: line.component_item_id,
          locationId: line.from_location_id,
          uom: line.uom,
          quantity: roundQuantity(toNumber(line.quantity_issued))
        })),
        client
      );
      projectionOps.push(
        ...projectionEngine.buildIssueProjectionOps({
          tenantId,
          issueId,
          movementId: movement.movementId,
          now,
          workOrderId,
          workOrder,
          isDisassembly,
          issuedTotal,
          validationOverrideMetadata: validation.overrideMetadata ?? null,
          context,
          linesForPosting
        })
      );

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
          eventFactory.buildInventoryMovementPostedEvent(movement.movementId),
          eventFactory.buildWorkOrderIssuePostedEvent({
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
      if ((existing.rowCount ?? 0) > 0) {
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
      const occurredAt = new Date(execution.occurred_at);
      const baseCompletionMovement = movementPlanner.buildCompletionMovement({
        header: {
          id: execution.production_movement_id ?? uuidv4(),
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_completion:${completionId}:${workOrderId}`
            : `work_order_completion:${completionId}:${workOrderId}`,
          sourceType: 'work_order_completion_post',
          sourceId: completionId,
          idempotencyKey: `wo-completion-post:${completionId}`,
          occurredAt,
          postedAt: occurredAt,
          notes: execution.notes ?? null,
          metadata: {
            workOrderId,
            workOrderNumber: workOrder.number ?? workOrder.work_order_number
          },
          createdAt: occurredAt,
          updatedAt: occurredAt
        },
        lines: sortedMovementLines.map((preparedLine) => ({
          sourceLineId: preparedLine.sourceLineId,
          warehouseId: preparedLine.warehouseId,
          itemId: preparedLine.line.item_id,
          locationId: preparedLine.line.to_location_id!,
          canonicalFields: preparedLine.canonicalFields,
          reasonCode: preparedLine.reasonCode,
          lineNotes: preparedLine.line.notes ?? `Work order completion ${completionId}`
        }))
      });
      if (completionState === 'posted_completion') {
        return replayEngine.replayCompletion({
          tenantId,
          workOrderId,
          completionId,
          movementId: execution.production_movement_id!,
          expectedLineCount: baseCompletionMovement.expectedLineCount,
          expectedDeterministicHash: baseCompletionMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client)
        });
      }

      statePolicy.assertManufacturingTransition({
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
      const pendingWipAllocation = await wipEngine.lockOpenWip(client, {
        tenantId,
        scope: { kind: 'workOrder', workOrderId }
      });
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
      const plannedCompletionMovement = movementPlanner.buildCompletionMovement({
        header: {
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
          occurredAt,
          postedAt: now,
          notes: execution.notes ?? null,
          metadata: {
            workOrderId,
            workOrderNumber: workOrder.number ?? workOrder.work_order_number
          },
          createdAt: now,
          updatedAt: now
        },
        lines: plannedMovementLines.map(({ preparedLine, allocatedCost, unitCost }) => ({
          sourceLineId: preparedLine.sourceLineId,
          warehouseId: preparedLine.warehouseId,
          itemId: preparedLine.line.item_id,
          locationId: preparedLine.line.to_location_id!,
          canonicalFields: preparedLine.canonicalFields,
          reasonCode: preparedLine.reasonCode,
          lineNotes: preparedLine.line.notes ?? `Work order completion ${completionId}`,
          unitCost,
          extendedCost: allocatedCost
        }))
      });
      const movement = await persistInventoryMovement(client, plannedCompletionMovement.persistInput);

      if (!movement.created) {
        return replayEngine.replayCompletion({
          tenantId,
          workOrderId,
          completionId,
          movementId: movement.movementId,
          expectedLineCount: plannedCompletionMovement.expectedLineCount,
          expectedDeterministicHash: plannedCompletionMovement.expectedDeterministicHash,
          client,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: () =>
            fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client)
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
      await wipEngine.allocateWipCost(client, {
        tenantId,
        executionId: completionId,
        allocatedAt: now,
        pending: pendingWipAllocation
      });

      const completionUomSet = new Set(
        sortedMovementLines.map((line) => line.canonicalFields.canonicalUom)
      );
      const completionCanonicalUom =
        completionUomSet.size === 1 ? sortedMovementLines[0]?.canonicalFields.canonicalUom ?? null : null;
      await wipEngine.createWipValuationRecord(client, {
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
      await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
      projectionOps.push(
        ...projectionEngine.buildCompletionProjectionOps({
          tenantId,
          completionId,
          movementId: movement.movementId,
          now,
          workOrderId,
          workOrder,
          isDisassembly,
          totalIssueCost,
          wipUnitCostCanonical,
          totalProducedCanonical,
          totalProduced
        })
      );

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
          eventFactory.buildInventoryMovementPostedEvent(movement.movementId),
          eventFactory.buildWorkOrderCompletionPostedEvent({
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
  if (data.warehouseId) {
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
      [tenantId, data.warehouseId]
    );
    if (!sellableDefaultRes.rows[0]?.is_sellable) {
      throw domainError('MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE', {
        workOrderId,
        warehouseId: data.warehouseId,
        locationId: sellableDefaultRes.rows[0]?.location_id ?? null
      });
    }
  }

  const routing = await deriveWorkOrderStageRouting(tenantId, {
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
      idempotencyEndpoint: IDEMPOTENCY_ENDPOINTS.WORK_ORDER_REPORT_PRODUCTION,
      traceability: {
        outputItemId: workOrder.outputItemId,
        outputQty,
        outputUom,
        outputLotId: data.outputLotId ?? null,
        outputLotCode: data.outputLotCode ?? null,
        productionBatchId: data.productionBatchId ?? null,
        inputLots: Array.isArray(data.inputLots)
          ? data.inputLots.map((inputLot) => ({
            componentItemId: inputLot.componentItemId,
            lotId: inputLot.lotId,
            uom: inputLot.uom,
            quantity: toNumber(inputLot.quantity)
          }))
          : [],
        workOrderNumber: workOrder.number ?? workOrder.id,
        occurredAt
      }
    }
  );

  if (shouldSimulateLotLinkFailureOnce(reportIdempotencyKey, batchResult.replayed)) {
    throw domainError('WO_REPORT_LOT_LINK_INCOMPLETE', {
      reason: 'simulated_failure_after_post_before_lot_link',
      workOrderId,
      productionReportId: batchResult.executionId
    });
  }

  let lotTracking: Awaited<ReturnType<typeof lotTraceability.appendTraceabilityLinks>>;
  try {
    lotTracking = await lotTraceability.appendTraceabilityLinks(tenantId, {
      executionId: batchResult.executionId,
      outputItemId: workOrder.outputItemId,
      outputQty,
      outputUom,
      outputLotId: data.outputLotId ?? null,
      outputLotCode: data.outputLotCode ?? null,
      inputLots: Array.isArray(data.inputLots)
        ? data.inputLots.map((inputLot) => ({
          componentItemId: inputLot.componentItemId,
          lotId: inputLot.lotId,
          uom: inputLot.uom,
          quantity: toNumber(inputLot.quantity)
        }))
        : []
    });
  } catch (error: any) {
    if (!lotTraceability.isNonRetryableLotLinkError(error)) {
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
      const replay = await replayEngine.replayVoid({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.workOrderExecutionId,
          componentReturnMovementId: responseBody.componentReturnMovementId,
          outputReversalMovementId: responseBody.outputReversalMovementId,
          client,
          idempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, responseBody.workOrderId);
          },
          fetchAggregateView: async () => {
            const res = await client.query<{ id: string; work_order_id: string }>(
              `SELECT id, work_order_id
                 FROM work_order_executions
                WHERE tenant_id = $1
                  AND id = $2
                  AND work_order_id = $3
                FOR UPDATE`,
              [tenantId, responseBody.workOrderExecutionId, responseBody.workOrderId]
            );
            if (res.rowCount === 0) {
              return null;
            }
            return {
              workOrderId: responseBody.workOrderId,
              workOrderExecutionId: responseBody.workOrderExecutionId,
              componentReturnMovementId: responseBody.componentReturnMovementId,
              outputReversalMovementId: responseBody.outputReversalMovementId,
              idempotencyKey,
              replayed: true
            };
          }
        });
      return replay.responseBody as WorkOrderVoidReportResult;
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
      statePolicy.assertManufacturingTransition({
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
        const replay = await replayEngine.replayVoid({
          tenantId,
          workOrderId,
          executionId: currentExecution.id,
          componentReturnMovementId: existingPair.componentReturnMovementId,
          outputReversalMovementId: existingPair.outputReversalMovementId,
          expectedComponentLineCount: plannedComponentLines.length,
          expectedOutputLineCount: plannedOutputLines.length,
          client,
          idempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
          },
          fetchAggregateView: async () => ({
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            componentReturnMovementId: existingPair.componentReturnMovementId,
            outputReversalMovementId: existingPair.outputReversalMovementId,
            idempotencyKey,
            replayed: true
          })
        });
        return replay as any;
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
          consumption_document_id: currentExecution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${currentExecution.id}`
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
      const plannedVoidMovement = movementPlanner.buildVoidMovement({
        outputHeader: {
          id: outputMovementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_OUTPUT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:output` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void production output for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        outputLines: plannedOutputMovementLines.map(({ plannedOutputLine, unitCost, extendedCost }) => ({
          sourceLineId: plannedOutputLine.sourceLineId,
          warehouseId: plannedOutputLine.warehouseId,
          itemId: plannedOutputLine.line.item_id,
          locationId: plannedOutputLine.line.location_id,
          canonicalFields: plannedOutputLine.canonicalFields,
          reasonCode: plannedOutputLine.reasonCode,
          lineNotes: plannedOutputLine.lineNotes,
          unitCost,
          extendedCost
        })),
        componentHeader: {
          id: componentMovementId,
          tenantId,
          movementType: 'receive',
          status: 'posted',
          externalRef: `${WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE}:${currentExecution.id}:${workOrderId}`,
          sourceType: WORK_ORDER_VOID_COMPONENT_SOURCE_TYPE,
          sourceId: currentExecution.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:components` : null,
          occurredAt: now,
          postedAt: now,
          notes: data.notes ?? `Void component return for execution ${currentExecution.id}: ${reason}`,
          metadata: {
            workOrderId,
            workOrderExecutionId: currentExecution.id,
            reason
          },
          createdAt: now,
          updatedAt: now
        },
        componentLines: plannedComponentMovementLines.map(({ plannedComponentLine, unitCost, extendedCost }) => ({
          sourceLineId: plannedComponentLine.sourceLineId,
          warehouseId: plannedComponentLine.warehouseId,
          itemId: plannedComponentLine.line.item_id,
          locationId: plannedComponentLine.line.location_id,
          canonicalFields: plannedComponentLine.canonicalFields,
          reasonCode: plannedComponentLine.reasonCode,
          lineNotes: plannedComponentLine.lineNotes,
          unitCost,
          extendedCost
        }))
      });

      const outputMovement = await persistInventoryMovement(client, plannedVoidMovement.output.persistInput);
      const componentMovement = await persistInventoryMovement(client, plannedVoidMovement.components.persistInput);

      if (!outputMovement.created || !componentMovement.created) {
        const replayPair = await fetchVoidMovementPair(client, tenantId, currentExecution.id);
        if (replayPair) {
          const replay = await replayEngine.replayVoid({
            tenantId,
            workOrderId,
            executionId: currentExecution.id,
            componentReturnMovementId: replayPair.componentReturnMovementId,
            outputReversalMovementId: replayPair.outputReversalMovementId,
            expectedComponentLineCount: plannedVoidMovement.components.expectedLineCount,
            expectedOutputLineCount: plannedVoidMovement.output.expectedLineCount,
            expectedComponentDeterministicHash: plannedVoidMovement.components.expectedDeterministicHash,
            expectedOutputDeterministicHash: plannedVoidMovement.output.expectedDeterministicHash,
            client,
            idempotencyKey,
            preFetchIntegrityCheck: async () => {
              await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
            },
            fetchAggregateView: async () => ({
              workOrderId,
              workOrderExecutionId: currentExecution.id,
              componentReturnMovementId: replayPair.componentReturnMovementId,
              outputReversalMovementId: replayPair.outputReversalMovementId,
              idempotencyKey,
              replayed: true
            })
          });
          return replay as any;
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
          consumption_document_id: currentExecution.id,
          movement_id: outputMovementId,
          client,
          notes: `work_order_void_output:${currentExecution.id}`,
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
          source_document_id: currentExecution.id,
          movement_id: componentMovementId,
          notes: `Work-order void component return for execution ${currentExecution.id}`,
          client
        });
      }

      await wipEngine.reverseWipCost(client, {
        tenantId,
        workOrderId,
        executionId: currentExecution.id,
        originalIssueMovementId: currentExecution.consumption_movement_id!,
        originalReportMovementId: currentExecution.production_movement_id!,
        outputMovementId: outputMovementId,
        componentMovementId: componentMovementId,
        outputReversalCost: totalOutputReversalCost,
        componentReturnCost: totalComponentReturnCost
      });

      projectionOps.push(
        ...projectionEngine.buildVoidProjectionOps({
          tenantId,
          workOrderId,
          executionId: currentExecution.id,
          outputReversalMovementId: outputMovementId,
          componentReturnMovementId: componentMovementId,
          reason,
          actor,
          now
        })
      );

      return {
        responseBody: {
          workOrderId,
          workOrderExecutionId: currentExecution.id,
          componentReturnMovementId: componentMovementId,
          outputReversalMovementId: outputMovementId,
          idempotencyKey,
          replayed: false
        },
        responseStatus: 201,
        events: [
          eventFactory.buildInventoryMovementPostedEvent(componentMovementId, idempotencyKey),
          eventFactory.buildInventoryMovementPostedEvent(outputMovementId, idempotencyKey),
          eventFactory.buildWorkOrderProductionReversedEvent({
            executionId: currentExecution.id,
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
      await replayEngine.replayTransferBackedScrap({
        tenantId,
        workOrderId,
        workOrderExecutionId: responseBody.workOrderExecutionId,
        itemId: responseBody.itemId,
        quantity: responseBody.quantity,
        uom: responseBody.uom,
        scrapMovementId: responseBody.scrapMovementId,
        idempotencyKey,
        client
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
      const resolvedScrapLocationId = await getWarehouseDefaultLocationId(
        tenantId,
        warehouseId,
        'SCRAP',
        client
      );
      if (!resolvedScrapLocationId) {
        throw new Error('WO_SCRAP_LOCATION_REQUIRED');
      }
      scrapLocationId = resolvedScrapLocationId;
      statePolicy.assertInventoryStateTransition({
        flow: 'scrap',
        currentState: 'QA',
        targetState: 'SCRAP',
        workOrderId,
        executionOrDocumentId: execution.id
      });

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
      const plannedScrapMovement = movementPlanner.buildScrapMovement({
        preparedTransfer
      });
      const transferExecution = await executeTransferInventoryMutation(
        plannedScrapMovement.preparedTransfer,
        client
      );
      const now = new Date();
      const projectionOps = [
        ...transferExecution.projectionOps,
        ...projectionEngine.buildScrapProjectionOps({
          tenantId,
          workOrderId,
          quantity,
          now,
          created: transferExecution.result.created
        })
      ];
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
  options?: {
    idempotencyKey?: string | null;
    idempotencyEndpoint?: string;
    traceability?: {
      outputItemId: string;
      outputQty: number;
      outputUom: string;
      outputLotId?: string | null;
      outputLotCode?: string | null;
      productionBatchId?: string | null;
      inputLots?: lotTraceability.WorkOrderInputLotLink[];
      workOrderNumber: string;
      occurredAt: Date;
    };
  }
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
  let existingBatchReplay: Awaited<ReturnType<typeof replayEngine.findPostedBatchByIdempotencyKey>> | null = null;
  let warehouseByLocationId = new Map<string, string>();
  let consumeLinesOrdered: NormalizedBatchConsumeLine[] = [];
  let produceLinesOrdered: NormalizedBatchProduceLine[] = [];
  let preparedTraceability: lotTraceability.PreparedWorkOrderTraceability | null = null;
  let reservationSnapshot: Awaited<ReturnType<typeof ensureWorkOrderReservationsReady>> = [];

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
      const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: responseBody.workOrderId,
          executionId: responseBody.executionId,
          issueMovementId: responseBody.issueMovementId,
          receiveMovementId: responseBody.receiveMovementId,
          expectedIssueLineCount: normalizedConsumes.length,
          expectedReceiveLineCount: normalizedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, responseBody.workOrderId);
          },
          fetchAggregateView: async () => {
            const res = await client.query<{
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
              [tenantId, responseBody.executionId, responseBody.workOrderId]
            );
            const row = res.rows[0];
            if (!row) {
              return null;
            }
            return {
              workOrderId: row.work_order_id,
              executionId: row.execution_id,
              issueMovementId: responseBody.issueMovementId,
              receiveMovementId: responseBody.receiveMovementId,
              quantityCompleted: roundQuantity(toNumber(row.quantity_completed ?? 0)),
              workOrderStatus: row.work_order_status,
              idempotencyKey: batchIdempotencyKey,
              replayed: true
            };
          }
        });
      return replay.responseBody as {
        workOrderId: string;
        executionId: string;
        issueMovementId: string;
        receiveMovementId: string;
        quantityCompleted: number;
        workOrderStatus: string;
        idempotencyKey: string | null;
        replayed: boolean;
      };
    },
    lockTargets: async (client) => {
      existingBatchReplay = null;
      preparedTraceability = null;
      reservationSnapshot = [];
      if (batchIdempotencyKey) {
        existingBatchReplay = await replayEngine.findPostedBatchByIdempotencyKey(
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
      reservationSnapshot = await ensureWorkOrderReservationsReady(tenantId, workOrderId, client);
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
        const locationById = new Map(locRes.rows.map((row) => [row.id, row]));
        for (const line of consumeLinesOrdered) {
          const consumeLocation = locationById.get(line.fromLocationId);
          if (!consumeLocation?.is_sellable) {
            throw domainError('MANUFACTURING_CONSUMPTION_MUST_BE_SELLABLE', {
              workOrderId,
              componentItemId: line.componentItemId,
              locationId: line.fromLocationId
            });
          }
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
        const replay = await replayEngine.replayBatch({
          tenantId,
          workOrderId: existingBatchReplay.workOrderId,
          executionId: existingBatchReplay.executionId,
          issueMovementId: existingBatchReplay.issueMovementId,
          receiveMovementId: existingBatchReplay.receiveMovementId,
          expectedIssueLineCount: sortedConsumes.length,
          expectedReceiveLineCount: sortedProduces.length,
          client,
          idempotencyKey: batchIdempotencyKey,
          preFetchIntegrityCheck: async () => {
            await wipEngine.verifyWipIntegrity(client, tenantId, existingBatchReplay!.workOrderId);
          },
          fetchAggregateView: async () => ({
            workOrderId: existingBatchReplay!.workOrderId,
            executionId: existingBatchReplay!.executionId,
            issueMovementId: existingBatchReplay!.issueMovementId,
            receiveMovementId: existingBatchReplay!.receiveMovementId,
            quantityCompleted: existingBatchReplay!.quantityCompleted,
            workOrderStatus: existingBatchReplay!.workOrderStatus,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          })
        });
        return replay as any;
      }
      const executionId = uuidv4();
      statePolicy.assertManufacturingTransition({
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
      const reservationOpenByKey = new Map(
        reservationSnapshot.map((line) => [
          `${line.componentItemId}:${line.locationId}:${line.uom}`,
          line.openReservedQty
        ])
      );
      const validationByKey = new Map<
        string,
        { warehouseId: string; itemId: string; locationId: string; uom: string; requestedQty: number }
      >();
      for (const preparedConsume of sortedConsumes) {
        const key = `${preparedConsume.line.componentItemId}:${preparedConsume.line.fromLocationId}:${preparedConsume.canonicalFields.canonicalUom}`;
        const existing = validationByKey.get(key);
        const requestedQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
        if (existing) {
          existing.requestedQty = roundQuantity(existing.requestedQty + requestedQty);
        } else {
          validationByKey.set(key, {
            warehouseId: preparedConsume.warehouseId,
            itemId: preparedConsume.line.componentItemId,
            locationId: preparedConsume.line.fromLocationId,
            uom: preparedConsume.canonicalFields.canonicalUom,
            requestedQty
          });
        }
      }
      const validationLines = Array.from(validationByKey.entries())
        .map(([key, line]) => ({
          warehouseId: line.warehouseId,
          itemId: line.itemId,
          locationId: line.locationId,
          uom: line.uom,
          quantityToConsume: roundQuantity(
            Math.max(0, line.requestedQty - (reservationOpenByKey.get(key) ?? 0))
          )
        }))
        .filter((line) => line.quantityToConsume > 1e-6);
      if (options?.traceability) {
        preparedTraceability = await lotTraceability.prepareTraceability(client, {
          tenantId,
          executionId,
          outputItemId: options.traceability.outputItemId,
          outputLotId: options.traceability.outputLotId ?? null,
          outputLotCode: options.traceability.outputLotCode ?? null,
          productionBatchId: options.traceability.productionBatchId ?? null,
          inputLots: options.traceability.inputLots ?? [],
          workOrderNumber: options.traceability.workOrderNumber,
          occurredAt: options.traceability.occurredAt
        });
      }
      const validation = await validateSufficientStock(
        tenantId,
        occurredAt,
        validationLines,
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
      const plannedBatchMovement = movementPlanner.buildBatchMovement({
        issueHeader: {
          id: issueMovementId,
          tenantId,
          movementType: 'issue',
          status: 'posted',
          externalRef: isDisassembly
            ? `work_order_disassembly_issue:${issueId}:${workOrderId}`
            : `work_order_batch_issue:${issueId}:${workOrderId}`,
          sourceType: 'work_order_batch_post_issue',
          sourceId: executionId,
          idempotencyKey: batchIdempotencyKey
            ? `${batchIdempotencyKey}:issue`
            : `wo-batch-issue-post:${executionId}`,
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
        },
        issueLines: plannedIssueMovementLines.map(({ preparedConsume, issueCost }) => {
          const canonicalQty = Math.abs(preparedConsume.canonicalFields.quantityDeltaCanonical);
          const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
          const extendedCost = issueCost !== null ? -issueCost : null;
          return {
            sourceLineId: preparedConsume.sourceLineId,
            warehouseId: preparedConsume.warehouseId,
            itemId: preparedConsume.line.componentItemId,
            locationId: preparedConsume.line.fromLocationId,
            canonicalFields: preparedConsume.canonicalFields,
            reasonCode: preparedConsume.reasonCode,
            lineNotes: preparedConsume.line.notes ?? null,
            unitCost,
            extendedCost
          };
        }),
        completionHeader: {
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
          metadata: {
            workOrderId,
            workOrderNumber,
            ...(preparedTraceability
              ? {
                lotId: preparedTraceability.outputLotId,
                productionBatchId: preparedTraceability.productionBatchId
              }
              : {})
          },
          createdAt: now,
          updatedAt: now,
          lotId: preparedTraceability?.outputLotId ?? null,
          productionBatchId: preparedTraceability?.productionBatchId ?? null
        },
        completionLines: plannedReceiveMovementLines.map(({ preparedProduce, allocatedCost, unitCost }) => ({
          sourceLineId: preparedProduce.sourceLineId,
          warehouseId: preparedProduce.warehouseId,
          itemId: preparedProduce.line.outputItemId,
          locationId: preparedProduce.line.toLocationId,
          canonicalFields: preparedProduce.canonicalFields,
          reasonCode: preparedProduce.reasonCode,
          lineNotes: preparedProduce.line.notes ?? null,
          unitCost,
          extendedCost: allocatedCost
        }))
      });

      const issueMovement = await persistInventoryMovement(client, plannedBatchMovement.issue.persistInput);
      const receiveMovement = await persistInventoryMovement(client, plannedBatchMovement.completion.persistInput);

      if (!issueMovement.created || !receiveMovement.created) {
        if (batchIdempotencyKey) {
          const replay = await replayEngine.findPostedBatchByIdempotencyKey(
            client,
            tenantId,
            batchIdempotencyKey,
            requestHash
          );
          if (replay) {
            const replayResult = await replayEngine.replayBatch({
              tenantId,
              workOrderId,
              executionId: replay.executionId,
              issueMovementId: replay.issueMovementId,
              receiveMovementId: replay.receiveMovementId,
              expectedIssueLineCount: plannedBatchMovement.issue.expectedLineCount,
              expectedReceiveLineCount: plannedBatchMovement.completion.expectedLineCount,
              expectedIssueDeterministicHash: plannedBatchMovement.issue.expectedDeterministicHash,
              expectedReceiveDeterministicHash: plannedBatchMovement.completion.expectedDeterministicHash,
              client,
              idempotencyKey: batchIdempotencyKey,
              preFetchIntegrityCheck: async () => {
                await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
              },
              fetchAggregateView: async () => ({
                workOrderId,
                executionId: replay.executionId,
                issueMovementId: replay.issueMovementId,
                receiveMovementId: replay.receiveMovementId,
                quantityCompleted: replay.quantityCompleted,
                workOrderStatus: replay.workOrderStatus,
                idempotencyKey: batchIdempotencyKey,
                replayed: true
              })
            });
            return replayResult as any;
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
            output_lot_id, production_batch_id, notes, idempotency_key, idempotency_request_hash,
            idempotency_request_summary, created_at
         ) VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          executionId,
          tenantId,
          workOrderId,
          occurredAt,
          issueMovementId,
          receiveMovementId,
          preparedTraceability?.outputLotId ?? null,
          preparedTraceability?.productionBatchId ?? null,
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

      const pendingWipAllocation = await wipEngine.lockOpenWip(client, {
        tenantId,
        scope: { kind: 'movement', movementId: issueMovementId }
      });
      const totalIssueCost = await wipEngine.allocateWipCost(client, {
        tenantId,
        executionId,
        allocatedAt: now,
        pending: pendingWipAllocation
      });
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

      await wipEngine.createWipValuationRecord(client, {
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
      await wipEngine.createWipValuationRecord(client, {
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
      await wipEngine.verifyWipIntegrity(client, tenantId, workOrderId);
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

      projectionOps.push(
        ...projectionEngine.buildBatchProjectionOps({
          tenantId,
          executionId,
          workOrderId,
          issueMovementId,
          now,
          workOrder,
          totalIssueCost,
          wipUnitCostCanonical,
          producedCanonicalTotal,
          newCompleted,
          newStatus,
          completedAt,
          validationOverrideMetadata: validation.overrideMetadata ?? null,
          context,
          consumeLinesOrdered
        })
      );

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
          eventFactory.buildInventoryMovementPostedEvent(issueMovementId, batchIdempotencyKey),
          eventFactory.buildInventoryMovementPostedEvent(receiveMovementId, batchIdempotencyKey),
          eventFactory.buildWorkOrderProductionReportedEvent({
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
