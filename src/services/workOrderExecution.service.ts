import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { createHash } from 'crypto';
import { query, withTransaction, withTransactionRetry } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock } from './stockValidation.service';
import { consumeCostLayers, createCostLayer } from './costLayers.service';
import { getCanonicalMovementFields, type CanonicalMovementFields } from './uomCanonical.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderBatchSchema
} from '../schemas/workOrderExecution.schema';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderBatchInput = z.infer<typeof workOrderBatchSchema>;

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

export async function recordWorkOrderBatch(
  tenantId: string,
  workOrderId: string,
  data: WorkOrderBatchInput,
  context: NegativeOverrideContext = {},
  options?: { idempotencyKey?: string | null }
) {
  const batchIdempotencyKey = options?.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const normalizedConsumes: NormalizedBatchConsumeLine[] = data.consumeLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_CONSUME_QTY');
    }
    return { ...line, quantity, uom: line.uom, reasonCode: line.reasonCode ?? null };
  });
  const normalizedProduces: NormalizedBatchProduceLine[] = data.produceLines.map((line) => {
    const quantity = toNumber(line.quantity);
    if (quantity <= 0) {
      throw new Error('WO_BATCH_INVALID_PRODUCE_QTY');
    }
    return { ...line, quantity, uom: line.uom, reasonCode: line.reasonCode ?? null, packSize: line.packSize ?? null };
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
        return replayPayload;
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
      const locRes = await client.query<{ id: string }>(
        'SELECT id FROM locations WHERE id = ANY($1) AND tenant_id = $2',
        [locationIds, tenantId]
      );
      const found = new Set(locRes.rows.map((r) => r.id));
      const missingLocs = locationIds.filter((id) => !found.has(id));
      if (missingLocs.length > 0) {
        throw new Error(`WO_BATCH_LOCATIONS_MISSING:${missingLocs.join(',')}`);
      }
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
          const { executionId: _executionId, ...replayPayload } = replay;
          return replayPayload;
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
          const { executionId: _executionId, ...replayPayload } = replay;
          return replayPayload;
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
          const { executionId: _executionId, ...replayPayload } = replay;
          return replayPayload;
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
      issueMovementId,
      receiveMovementId,
      quantityCompleted: newCompleted,
      workOrderStatus: newStatus
    };
  }, WORK_ORDER_POST_RETRY_OPTIONS);
}
