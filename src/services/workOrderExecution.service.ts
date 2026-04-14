import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById } from './boms.service';
import { getWarehouseDefaultLocationId } from './warehouseDefaults.service';
import {
  workOrderCompletionCreateSchema,
  workOrderIssueCreateSchema,
  workOrderReportScrapSchema
} from '../schemas/workOrderExecution.schema';
import {
  buildTransferLockTargets,
  executeTransferInventoryMutation,
  prepareTransferMutation,
  type PreparedTransferMutation
} from './transfers.service';
import {
  hashTransactionalIdempotencyRequest
} from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  runInventoryCommand
} from '../modules/platform/application/runInventoryCommand';
import {
  isTerminalWorkOrderStatus
} from './workOrderLifecycle.service';
import {
  assertWorkOrderRoutingLine
} from './stageRouting.service';
import * as replayEngine from './inventoryReplayEngine';
import * as statePolicy from './inventoryStatePolicy';
import * as wipEngine from './wipAccountingEngine';
import * as movementPlanner from './inventoryMovementPlanner';
import * as projectionEngine from './inventoryProjectionEngine';
import {
  assertScrapReasonCode,
  normalizedOptionalIdempotencyKey
} from './workOrderExecution.request';
import { fetchWorkOrderIssue } from './workOrderIssuePost.workflow';
import { fetchWorkOrderCompletion } from './workOrderCompletionPost.workflow';

export { fetchWorkOrderIssue, postWorkOrderIssue } from './workOrderIssuePost.workflow';
export { fetchWorkOrderCompletion, postWorkOrderCompletion } from './workOrderCompletionPost.workflow';
export { recordWorkOrderBatch } from './workOrderBatchRecord.workflow';
export { fetchWorkOrderVoidReportResult, voidWorkOrderProductionReport } from './workOrderVoidProduction.workflow';
export type { WorkOrderVoidReportResult } from './workOrderVoidProduction.workflow';
export { reportWorkOrderProduction } from './workOrderProductionReport.workflow';
export type { WorkOrderProductionReportResult } from './workOrderProductionReport.workflow';

// Disassembly/rework is modeled as work_orders.kind = 'disassembly' and posts issue/receive movements
// (never inventory_adjustments). External refs include work order ids for traceability.

type WorkOrderIssueCreateInput = z.infer<typeof workOrderIssueCreateSchema>;
type WorkOrderCompletionCreateInput = z.infer<typeof workOrderCompletionCreateSchema>;
type WorkOrderReportScrapInput = z.infer<typeof workOrderReportScrapSchema>;
type RetryableSqlStateError = { retrySqlState?: string; code?: string };

const WORK_ORDER_POST_RETRY_OPTIONS = { isolationLevel: 'SERIALIZABLE' as const, retries: 8 };

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

type WorkOrderIssuedTotalRow = {
  component_item_id: string;
  component_item_sku: string;
  component_item_name: string;
  uom: string;
  qty: string | number;
};

type WorkOrderCompletedTotalRow = {
  item_id: string;
  item_sku: string;
  item_name: string;
  uom: string;
  qty: string | number;
};

async function fetchWorkOrderById(
  tenantId: string,
  id: string,
  client?: PoolClient,
  options?: { forUpdate?: boolean }
): Promise<WorkOrderRow | null> {
  const executor = client ? client.query.bind(client) : query;
  const lockClause = client && options?.forUpdate ? ' FOR UPDATE' : '';
  const result = await executor<WorkOrderRow>(
    `SELECT *
       FROM work_orders
      WHERE id = $1
        AND tenant_id = $2${lockClause}`,
    [id, tenantId]
  );
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

export async function getWorkOrderExecutionSummary(tenantId: string, workOrderId: string) {
  const workOrderResult = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    workOrderId,
    tenantId
  ]);
  if (workOrderResult.rowCount === 0) {
    return null;
  }
  const workOrder = workOrderResult.rows[0];

  const issuedRows = await query<WorkOrderIssuedTotalRow>(
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

  const producedRows = await query<WorkOrderCompletedTotalRow>(
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
    issuedTotals: issuedRows.rows.map((row) => ({
      componentItemId: row.component_item_id,
      componentItemSku: row.component_item_sku,
      componentItemName: row.component_item_name,
      uom: row.uom,
      quantityIssued: roundQuantity(toNumber(row.qty))
    })),
    completedTotals: producedRows.rows.map((row) => ({
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

const WORK_ORDER_SCRAP_SOURCE_TYPE = 'work_order_scrap';

type LockedExecutionRow = {
  id: string;
  work_order_id: string;
  status: string;
  occurred_at: string;
  consumption_movement_id: string | null;
  production_movement_id: string | null;
};

function assertSameWorkOrderExecution(
  workOrderId: string,
  execution: LockedExecutionRow
) {
  if (execution.work_order_id !== workOrderId) {
    throw new Error('WO_VOID_EXECUTION_WORK_ORDER_MISMATCH');
  }
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
    execute: async ({ client, lockContext }) => {
      if (!execution || !preparedTransfer || !itemId || !sourceLocationId || !scrapLocationId || !warehouseId) {
        throw new Error('WO_SCRAP_PREPARE_REQUIRED');
      }
      const plannedScrapMovement = movementPlanner.buildScrapMovement({
        preparedTransfer
      });
      const transferExecution = await executeTransferInventoryMutation(
        plannedScrapMovement.preparedTransfer,
        client,
        lockContext
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
