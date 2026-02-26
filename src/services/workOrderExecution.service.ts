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
  acquireAtpLocks,
  assertAtpLockHeldOrThrow,
  createAtpLockContext,
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
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

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;
type WorkOrderReportProductionInput = z.infer<typeof workOrderReportProductionSchema>;
type WorkOrderVoidReportProductionInput = z.infer<typeof workOrderVoidReportProductionSchema>;
type WorkOrderReportScrapInput = z.infer<typeof workOrderReportScrapSchema>;

const WIP_COST_METHOD = 'fifo';
const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 2 };

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
      WHERE movement_id = $1
      LIMIT 1`,
    [movementId]
  );
  if (lineRes.rowCount === 0) {
    throw new Error('WO_POSTING_IDEMPOTENCY_INCOMPLETE');
  }
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
  return withTransactionRetry(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const issueResult = await client.query<WorkOrderMaterialIssueRow>(
      'SELECT * FROM work_order_material_issues WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3 FOR UPDATE',
      [issueId, workOrderId, tenantId]
    );
    if (issueResult.rowCount === 0) {
      throw new Error('WO_ISSUE_NOT_FOUND');
    }
    const issue = issueResult.rows[0];
    if (issue.status === 'posted') {
      return fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    }
    if (issue.status === 'canceled') {
      throw new Error('WO_ISSUE_CANCELED');
    }

    const linesResult = await client.query<WorkOrderMaterialIssueLineRow>(
      'SELECT * FROM work_order_material_issue_lines WHERE work_order_material_issue_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
      [issueId, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_ISSUE_NO_LINES');
    }
    const linesForPosting = [...linesResult.rows].sort(compareIssueLineLockKey);

    const now = new Date();
    const occurredAt = new Date(issue.occurred_at);
    const validation = await validateSufficientStock(
      tenantId,
      occurredAt,
      linesForPosting.map((line) => ({
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
    const movementMetadata = {
      workOrderId,
      workOrderNumber,
      ...(validation.overrideMetadata ?? {})
    };
    const movementId = uuidv4();
    const movement = await createInventoryMovement(client, {
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
      metadata: movementMetadata,
      createdAt: now,
      updatedAt: now
    });

    if (!movement.created) {
      await ensurePostedMovementReady(client, tenantId, movement.id);
      await client.query(
        `UPDATE work_order_material_issues
            SET status = 'posted',
                inventory_movement_id = $1,
                updated_at = $2
          WHERE id = $3 AND tenant_id = $4`,
        [movement.id, now, issueId, tenantId]
      );
      await enqueueInventoryMovementPosted(client, tenantId, movement.id);
      return fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    }

    const issuedTotal = linesForPosting.reduce((sum, line) => {
      const qty = toNumber(line.quantity_issued);
      return sum + qty;
    }, 0);

    for (const line of linesForPosting) {
      if (isDisassembly && line.component_item_id !== workOrder.output_item_id) {
        throw new Error('WO_DISASSEMBLY_INPUT_MISMATCH');
      }
      const qty = toNumber(line.quantity_issued);
      if (qty <= 0) {
        throw new Error('WO_ISSUE_INVALID_QUANTITY');
      }
      const reasonCode = line.reason_code ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue');
      
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.component_item_id,
        -qty,
        line.uom,
        client
      );
      const canonicalQty = Math.abs(canonicalFields.quantityDeltaCanonical);
      
      // Consume from cost layers for material issue
      let issueCost = null as number | null;
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
      const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
      const extendedCost = issueCost !== null ? -issueCost : null;
      
      await createInventoryMovementLine(client, {
        tenantId,
        movementId: movement.id,
        itemId: line.component_item_id,
        locationId: line.from_location_id,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode,
        lineNotes: line.notes ?? `Work order issue ${issueId} line ${line.line_number}`
      });

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.component_item_id,
        locationId: line.from_location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
    }

    await client.query(
      `UPDATE work_order_material_issues
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
        WHERE id = $3 AND tenant_id = $4`,
      [movement.id, now, issueId, tenantId]
    );

    await enqueueInventoryMovementPosted(client, tenantId, movement.id);

    if (workOrder.status === 'draft') {
      await client.query(
        `UPDATE work_orders SET status = 'in_progress', updated_at = $2 WHERE id = $1 AND tenant_id = $3`,
        [workOrderId, now, tenantId]
      );
    }

    if (isDisassembly) {
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + issuedTotal;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const nextStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;
      await client.query(
        `UPDATE work_orders
            SET quantity_completed = $2,
                status = $3,
                completed_at = COALESCE(completed_at, $4),
                updated_at = $5
          WHERE id = $1 AND tenant_id = $6`,
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
        client
      );
    }

    const posted = await fetchWorkOrderIssue(tenantId, workOrderId, issueId, client);
    if (!posted) {
      throw new Error('WO_ISSUE_NOT_FOUND_AFTER_POST');
    }
    return posted;
  }, WORK_ORDER_POST_RETRY_OPTIONS);
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
  return withTransactionRetry(async (client) => {
    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }

    const execResult = await client.query<WorkOrderExecutionRow>(
      'SELECT * FROM work_order_executions WHERE id = $1 AND work_order_id = $2 AND tenant_id = $3 FOR UPDATE',
      [completionId, workOrderId, tenantId]
    );
    if (execResult.rowCount === 0) {
      throw new Error('WO_COMPLETION_NOT_FOUND');
    }
    const execution = execResult.rows[0];
    if (execution.status === 'posted') {
      return fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client);
    }
    if (execution.status === 'canceled') {
      throw new Error('WO_COMPLETION_CANCELED');
    }

    const linesResult = await client.query<WorkOrderExecutionLineRow>(
      'SELECT * FROM work_order_execution_lines WHERE work_order_execution_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
      [completionId, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('WO_COMPLETION_NO_LINES');
    }
    const linesForPosting = [...linesResult.rows].sort(compareProduceLineLockKey);

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
    }

    const now = new Date();
    const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
    const movementId = uuidv4();
    const movement = await createInventoryMovement(client, {
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
      metadata: { workOrderId, workOrderNumber },
      createdAt: now,
      updatedAt: now
    });

    if (!movement.created) {
      await ensurePostedMovementReady(client, tenantId, movement.id);
      await client.query(
        `UPDATE work_order_executions
            SET status = 'posted',
                production_movement_id = $1
          WHERE id = $2 AND tenant_id = $3`,
        [movement.id, completionId, tenantId]
      );
      await enqueueInventoryMovementPosted(client, tenantId, movement.id);
      return fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client);
    }

    const preparedLines: Array<{
      line: WorkOrderExecutionLineRow;
      qty: number;
      canonicalFields: CanonicalMovementFields;
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
      preparedLines.push({ line, qty, canonicalFields });
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

    for (const { line, qty, canonicalFields } of preparedLines) {
      const reasonCode = line.reason_code ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion');
      const allocationRatio = canonicalFields.quantityDeltaCanonical / totalProducedCanonical;
      const allocatedCost = totalIssueCost * allocationRatio;
      const unitCost =
        canonicalFields.quantityDeltaCanonical !== 0
          ? allocatedCost / canonicalFields.quantityDeltaCanonical
          : null;
      const extendedCost = allocatedCost;

      // Create cost layer for completed production output
      if (line.to_location_id) {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: line.item_id,
          location_id: line.to_location_id,
          uom: canonicalFields.canonicalUom,
          quantity: canonicalFields.quantityDeltaCanonical,
          unit_cost: unitCost ?? 0,
          source_type: 'production',
          source_document_id: completionId,
          movement_id: movement.id,
          notes: `Production output from work order ${workOrderId}`,
          client
        });
      }

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: movement.id,
        itemId: line.item_id,
        locationId: line.to_location_id,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode,
        lineNotes: line.notes ?? `Work order completion ${completionId}`
      });

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: line.to_location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
    }

    await client.query(
      `UPDATE work_order_executions
          SET status = 'posted',
              production_movement_id = $1,
              wip_total_cost = $2,
              wip_unit_cost = $3,
              wip_quantity_canonical = $4,
              wip_cost_method = $5,
              wip_costed_at = $6
        WHERE id = $7 AND tenant_id = $8`,
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

    await enqueueInventoryMovementPosted(client, tenantId, movement.id);

    if (!isDisassembly) {
      const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
      const newCompleted = currentCompleted + totalProduced;
      const planned = toNumber(workOrder.quantity_planned);
      const completedAt = newCompleted >= planned ? now : null;
      const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

      await client.query(
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
          WHERE id = $1 AND tenant_id = $10`,
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
    } else if (workOrder.status === 'draft') {
      await client.query(
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
          WHERE id = $1 AND tenant_id = $7`,
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
      await client.query(
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
          WHERE id = $1 AND tenant_id = $7`,
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

    const posted = await fetchWorkOrderCompletion(tenantId, workOrderId, completionId, client);
    if (!posted) {
      throw new Error('WO_COMPLETION_NOT_FOUND_AFTER_POST');
    }
    return posted;
  }, WORK_ORDER_POST_RETRY_OPTIONS);
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
  if (consumedRows.rowCount > 0) {
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

  const warehouseFromInput = await resolveWarehouseRootId(undefined, tenantId, data.warehouseId ?? null);
  const warehouseFromProduceDefault = workOrder.defaultProduceLocationId
    ? await resolveWarehouseIdForLocation(tenantId, workOrder.defaultProduceLocationId)
    : null;
  const warehouseFromConsumeDefault = workOrder.defaultConsumeLocationId
    ? await resolveWarehouseIdForLocation(tenantId, workOrder.defaultConsumeLocationId)
    : null;
  const warehouseId = warehouseFromInput ?? warehouseFromProduceDefault ?? warehouseFromConsumeDefault;
  if (!warehouseId) {
    throw new Error('WO_REPORT_WAREHOUSE_REQUIRED');
  }

  const consumeLocationId = await getWarehouseDefaultLocationId(tenantId, warehouseId, 'SELLABLE');
  const produceLocationId = await getWarehouseDefaultLocationId(tenantId, warehouseId, 'QA');
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
    { idempotencyKey: options?.idempotencyKey ?? data.idempotencyKey ?? null }
  );

  return {
    workOrderId,
    productionReportId: batchResult.executionId,
    componentIssueMovementId: batchResult.issueMovementId,
    productionReceiptMovementId: batchResult.receiveMovementId,
    idempotencyKey: batchResult.idempotencyKey ?? options?.idempotencyKey ?? data.idempotencyKey ?? null,
    replayed: batchResult.replayed
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

  return withTransactionRetry(async (client) => {
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
    const execution = executionRes.rows[0];
    assertSameWorkOrderExecution(workOrderId, execution);
    if (execution.status !== 'posted') {
      throw new Error('WO_VOID_EXECUTION_NOT_POSTED');
    }
    if (!execution.consumption_movement_id || !execution.production_movement_id) {
      throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
    }

    const existingPair = await fetchVoidMovementPair(client, tenantId, execution.id);
    if (existingPair) {
      return {
        workOrderId,
        workOrderExecutionId: execution.id,
        componentReturnMovementId: existingPair.componentReturnMovementId,
        outputReversalMovementId: existingPair.outputReversalMovementId,
        idempotencyKey,
        replayed: true
      };
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
    const originalIssue = originalMovements.rows.find((row) => row.id === execution.consumption_movement_id);
    const originalProduction = originalMovements.rows.find((row) => row.id === execution.production_movement_id);
    if (!originalIssue || !originalProduction) {
      throw new Error('WO_VOID_EXECUTION_MOVEMENTS_MISSING');
    }
    if (originalIssue.status !== 'posted' || originalProduction.status !== 'posted') {
      throw new Error('WO_VOID_EXECUTION_NOT_POSTED');
    }
    if (originalIssue.movement_type !== 'issue' || originalProduction.movement_type !== 'receive') {
      throw new Error('WO_VOID_EXECUTION_MOVEMENT_TYPE_INVALID');
    }

    const componentLines = await loadMovementLineScopes(
      client,
      tenantId,
      execution.consumption_movement_id,
      'negative'
    );
    const outputLines = await loadMovementLineScopes(
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

    const advisoryTargets = [
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
    const lockContext = createAtpLockContext({
      operation: 'work_order_batch_void',
      tenantId
    });
    await acquireAtpLocks(client, advisoryTargets, { lockContext });
    assertAtpLockHeldOrThrow(lockContext, { workOrderId, workOrderExecutionId: execution.id });

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
    if (!outputMovement.created) {
      await ensurePostedMovementReady(client, tenantId, outputMovement.id);
      throw new Error('WO_VOID_INCOMPLETE');
    }

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
    if (!componentMovement.created) {
      await ensurePostedMovementReady(client, tenantId, componentMovement.id);
      throw new Error('WO_VOID_INCOMPLETE');
    }

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

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: outputMovement.id,
        itemId: line.item_id,
        locationId: line.location_id,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode: 'work_order_void_output',
        lineNotes: `Void output reversal for work order execution ${execution.id}`
      });
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: line.location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
    }

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

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: componentMovement.id,
        itemId: line.item_id,
        locationId: line.location_id,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode: 'work_order_void_component_return',
        lineNotes: `Void component return for work order execution ${execution.id}`
      });
      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.item_id,
        locationId: line.location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
      await createCostLayer({
        tenant_id: tenantId,
        item_id: line.item_id,
        location_id: line.location_id,
        uom: canonicalFields.canonicalUom,
        quantity: canonicalFields.quantityDeltaCanonical,
        unit_cost: unitCost,
        source_type: 'adjustment',
        source_document_id: execution.id,
        movement_id: componentMovement.id,
        notes: `Work-order void component return for execution ${execution.id}`,
        client
      });
    }

    await enqueueInventoryMovementPosted(client, tenantId, outputMovement.id);
    await enqueueInventoryMovementPosted(client, tenantId, componentMovement.id);

    await recordAuditLog(
      {
        tenantId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'update',
        entityType: 'work_order_execution',
        entityId: execution.id,
        occurredAt: now,
        metadata: {
          workOrderId,
          workOrderExecutionId: execution.id,
          outputReversalMovementId: outputMovement.id,
          componentReturnMovementId: componentMovement.id,
          reason
        }
      },
      client
    );

    return {
      workOrderId,
      workOrderExecutionId: execution.id,
      componentReturnMovementId: componentMovement.id,
      outputReversalMovementId: outputMovement.id,
      idempotencyKey,
      replayed: false
    };
  }, WORK_ORDER_POST_RETRY_OPTIONS);
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

  return withTransactionRetry(async (client) => {
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

    const lockContext = createAtpLockContext({
      operation: 'work_order_scrap',
      tenantId
    });
    await acquireAtpLocks(
      client,
      [
        { tenantId, warehouseId, itemId }
      ],
      { lockContext }
    );
    assertAtpLockHeldOrThrow(lockContext, { workOrderId, workOrderExecutionId: execution.id });

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

    return {
      workOrderId,
      workOrderExecutionId: execution.id,
      scrapMovementId: transfer.movementId,
      itemId,
      quantity,
      uom: data.uom,
      idempotencyKey,
      replayed: !transfer.created
    };
  }, WORK_ORDER_POST_RETRY_OPTIONS);
}

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {},
  options?: { idempotencyKey?: string | null }
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
  const normalizedConsumes: NormalizedBatchConsumeLine[] = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return { ...line, quantity, uom: line.uom, reasonCode: line.reasonCode ?? null, notes: line.notes ?? null };
  });
  const normalizedProduces: NormalizedBatchProduceLine[] = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return {
      ...line,
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

  return withTransactionRetry(async (client) => {
    if (batchIdempotencyKey) {
      const existingBatch = await findPostedBatchByIdempotencyKey(
        client,
        tenantId,
        batchIdempotencyKey,
        requestHash
      );
      if (existingBatch) {
        const { executionId, ...replayPayload } = existingBatch;
        if (existingBatch.workOrderId !== workOrderId) {
          throw domainError('WO_POSTING_IDEMPOTENCY_CONFLICT', {
            reason: 'work_order_mismatch',
            executionId
          });
        }
        return {
          ...replayPayload,
          executionId,
          idempotencyKey: batchIdempotencyKey,
          replayed: true
        };
      }
    }

    const workOrder = await fetchWorkOrderById(tenantId, workOrderId, client);
    if (!workOrder) {
      throw new Error('WO_NOT_FOUND');
    }
    const isDisassembly = workOrder.kind === 'disassembly';
    if (workOrder.status === 'canceled' || workOrder.status === 'completed') {
      throw new Error('WO_INVALID_STATE');
    }
    const consumeLinesOrdered = [...normalizedConsumes].sort(compareBatchConsumeKey);
    const produceLinesOrdered = [...normalizedProduces].sort(compareBatchProduceKey);

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

    // Pre-validate items and locations to avoid foreign key failures
    const itemIds = Array.from(
      new Set([
        ...consumeLinesOrdered.map((l) => l.componentItemId),
        ...produceLinesOrdered.map((l) => l.outputItemId)
      ])
    );
    const locationIds = Array.from(
      new Set([
        ...consumeLinesOrdered.map((l) => l.fromLocationId),
        ...produceLinesOrdered.map((l) => l.toLocationId)
      ])
    );

    if (itemIds.length > 0) {
      const itemRes = await client.query<{ id: string }>(
        'SELECT id FROM items WHERE id = ANY($1) AND tenant_id = $2',
        [itemIds, tenantId]
      );
      const found = new Set(itemRes.rows.map((r) => r.id));
      const missingItems = itemIds.filter((id) => !found.has(id));
      if (missingItems.length > 0) {
        throw new Error(`WO_BATCH_ITEMS_MISSING:${missingItems.join(',')}`);
      }
    }

    if (locationIds.length > 0) {
      const locRes = await client.query<{
        id: string;
        warehouse_id: string | null;
        role: string | null;
        is_sellable: boolean;
      }>(
        'SELECT id, warehouse_id, role, is_sellable FROM locations WHERE id = ANY($1) AND tenant_id = $2',
        [locationIds, tenantId]
      );
      const found = new Set(locRes.rows.map((r) => r.id));
      const missingLocs = locationIds.filter((id) => !found.has(id));
      if (missingLocs.length > 0) {
        throw new Error(`WO_BATCH_LOCATIONS_MISSING:${missingLocs.join(',')}`);
      }
      const locationById = new Map(locRes.rows.map((row) => [row.id, row]));
      const warehouseByLocationId = new Map(locRes.rows.map((row) => [row.id, row.warehouse_id]));
      const advisoryTargets = [
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
      const missingWarehouseBindings = [
        ...consumeLinesOrdered
          .filter((line) => !warehouseByLocationId.get(line.fromLocationId))
          .map((line) => line.fromLocationId),
        ...produceLinesOrdered
          .filter((line) => !warehouseByLocationId.get(line.toLocationId))
          .map((line) => line.toLocationId)
      ];
      if (missingWarehouseBindings.length > 0) {
        throw new Error(`WO_BATCH_LOCATION_WAREHOUSE_MISSING:${Array.from(new Set(missingWarehouseBindings)).join(',')}`);
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
      // Manufacturing posting touches multiple item scopes; acquire warehouse/item advisory locks
      // in deterministic order before stock validation and movement posting to prevent cross-item races.
      const lockContext = createAtpLockContext({
        operation: 'work_order_batch_post',
        tenantId
      });
      await acquireAtpLocks(client, advisoryTargets, { lockContext });
      assertAtpLockHeldOrThrow(lockContext, { workOrderId });
    }

    const issueId = uuidv4();
    const executionId = uuidv4();
    const issueMovementCandidateId = uuidv4();
    const receiveMovementCandidateId = uuidv4();
    const now = new Date();
    const workOrderNumber = workOrder.number ?? workOrder.work_order_number;
    const validation = await validateSufficientStock(
      tenantId,
      occurredAt,
      consumeLinesOrdered.map((line) => ({
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

    // Create movements first to satisfy FKs
    const issueMovement = await createInventoryMovement(client, {
      id: issueMovementCandidateId,
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
    if (!issueMovement.created) {
      await ensurePostedMovementReady(client, tenantId, issueMovement.id);
      if (batchIdempotencyKey) {
        const replay = await findPostedBatchByIdempotencyKey(client, tenantId, batchIdempotencyKey, requestHash);
        if (replay) {
          return {
            ...replay,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          };
        }
      }
      throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        reason: 'issue_movement_already_exists_without_replayable_execution',
        missingExecutionIds: [],
        hint: 'Retry with the same Idempotency-Key or contact admin'
      });
    }
    const issueMovementId = issueMovement.id;
    const receiveMovement = await createInventoryMovement(client, {
      id: receiveMovementCandidateId,
      tenantId,
      movementType: 'receive',
      status: 'posted',
      externalRef: isDisassembly
        ? `work_order_disassembly_completion:${executionId}:${workOrderId}`
        : `work_order_batch_completion:${executionId}:${workOrderId}`,
      sourceType: 'work_order_batch_post_completion',
      sourceId: executionId,
      idempotencyKey: batchIdempotencyKey ? `${batchIdempotencyKey}:completion` : `wo-batch-completion-post:${executionId}`,
      occurredAt,
      postedAt: now,
      notes: data.notes ?? null,
      metadata: { workOrderId, workOrderNumber },
      createdAt: now,
      updatedAt: now
    });
    if (!receiveMovement.created) {
      await ensurePostedMovementReady(client, tenantId, receiveMovement.id);
      if (batchIdempotencyKey) {
        const replay = await findPostedBatchByIdempotencyKey(client, tenantId, batchIdempotencyKey, requestHash);
        if (replay) {
          return {
            ...replay,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          };
        }
      }
      throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
        reason: 'completion_movement_already_exists_without_replayable_execution',
        missingExecutionIds: [],
        hint: 'Retry with the same Idempotency-Key or contact admin'
      });
    }
    const receiveMovementId = receiveMovement.id;

    // Material issue header + lines
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
    for (let i = 0; i < consumeLinesOrdered.length; i++) {
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
    for (const line of consumeLinesOrdered) {
      const reasonCode = line.reasonCode ?? (isDisassembly ? 'disassembly_issue' : 'work_order_issue');
      
      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        line.componentItemId,
        -line.quantity,
        line.uom,
        client
      );
      const canonicalQty = Math.abs(canonicalFields.quantityDeltaCanonical);
      
      // Consume from cost layers for backflush material consumption
      let issueCost = null as number | null;
      try {
        const consumption = await consumeCostLayers({
          tenant_id: tenantId,
          item_id: line.componentItemId,
          location_id: line.fromLocationId,
          quantity: canonicalQty,
          consumption_type: 'production_input',
          consumption_document_id: issueId,
          movement_id: issueMovementId,
          client
        });
        issueCost = consumption.total_cost;
      } catch {
        throw new Error('WO_WIP_COST_LAYERS_MISSING');
      }
      const unitCost = issueCost !== null && canonicalQty !== 0 ? issueCost / canonicalQty : null;
      const extendedCost = issueCost !== null ? -issueCost : null;
      
      await createInventoryMovementLine(client, {
        tenantId,
        movementId: issueMovementId,
        itemId: line.componentItemId,
        locationId: line.fromLocationId,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode,
        lineNotes: line.notes ?? null
      });

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.componentItemId,
        locationId: line.fromLocationId,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
    }

    // Execution header + produce lines
    try {
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
    } catch (error: any) {
      if (batchIdempotencyKey && error?.code === '23505') {
        const replay = await findPostedBatchByIdempotencyKey(client, tenantId, batchIdempotencyKey, requestHash);
        if (replay) {
          return {
            ...replay,
            idempotencyKey: batchIdempotencyKey,
            replayed: true
          };
        }
        throw domainError('WO_POSTING_IDEMPOTENCY_INCOMPLETE', {
          reason: 'execution_insert_conflict_before_batch_finalization',
          missingExecutionIds: [],
          hint: 'Retry with the same Idempotency-Key or contact admin'
        });
      }
      throw error;
    }
    for (let i = 0; i < produceLinesOrdered.length; i++) {
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
      line: (typeof normalizedProduces)[number];
      canonicalFields: CanonicalMovementFields;
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
      preparedProduces.push({ line, canonicalFields });
    }

    if (producedCanonicalTotal <= 0) {
      throw new Error('WO_WIP_COST_INVALID_OUTPUT_QTY');
    }

    const totalIssueCost = await allocateWipCostFromMovement(
      client,
      tenantId,
      executionId,
      issueMovementId,
      now
    );
    const wipUnitCostCanonical = totalIssueCost / producedCanonicalTotal;

    for (const { line, canonicalFields } of preparedProduces) {
      const reasonCode = line.reasonCode ?? (isDisassembly ? 'disassembly_completion' : 'work_order_completion');
      const allocationRatio = canonicalFields.quantityDeltaCanonical / producedCanonicalTotal;
      const allocatedCost = totalIssueCost * allocationRatio;
      const unitCost =
        canonicalFields.quantityDeltaCanonical !== 0
          ? allocatedCost / canonicalFields.quantityDeltaCanonical
          : null;
      const extendedCost = allocatedCost;

      // Create cost layer for backflush production output
      await createCostLayer({
        tenant_id: tenantId,
        item_id: line.outputItemId,
        location_id: line.toLocationId,
        uom: canonicalFields.canonicalUom,
        quantity: canonicalFields.quantityDeltaCanonical,
        unit_cost: unitCost ?? 0,
        source_type: 'production',
        source_document_id: issueId,
        movement_id: receiveMovementId,
        notes: `Backflush production from work order ${workOrderId}`,
        client
      });

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: receiveMovementId,
        itemId: line.outputItemId,
        locationId: line.toLocationId,
        quantityDelta: canonicalFields.quantityDeltaCanonical,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode,
        lineNotes: line.notes ?? null
      });

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: line.outputItemId,
        locationId: line.toLocationId,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalFields.quantityDeltaCanonical
      });
    }

    await client.query(
      `UPDATE work_order_executions
          SET wip_total_cost = $1,
              wip_unit_cost = $2,
              wip_quantity_canonical = $3,
              wip_cost_method = $4,
              wip_costed_at = $5
        WHERE id = $6 AND tenant_id = $7`,
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

    // Update work order progress
    const consumedTotal = consumeLinesOrdered.reduce((sum, line) => sum + line.quantity, 0);
    const currentCompleted = toNumber(workOrder.quantity_completed ?? 0);
    const progressQty = isDisassembly ? consumedTotal : producedTotal;
    const newCompleted = currentCompleted + progressQty;
    const planned = toNumber(workOrder.quantity_planned);
    const completedAt = newCompleted >= planned ? now : null;
    const newStatus = newCompleted >= planned ? 'completed' : workOrder.status === 'draft' ? 'in_progress' : workOrder.status;

    await client.query(
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
        WHERE id = $1 AND tenant_id = $10`,
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

    await enqueueInventoryMovementPosted(client, tenantId, issueMovementId);
    await enqueueInventoryMovementPosted(client, tenantId, receiveMovementId);

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
        client
      );
    }

    return {
      workOrderId,
      executionId,
      issueMovementId,
      receiveMovementId,
      quantityCompleted: newCompleted,
      workOrderStatus: newStatus,
      idempotencyKey: batchIdempotencyKey,
      replayed: false
    };
  }, WORK_ORDER_POST_RETRY_OPTIONS);
}
