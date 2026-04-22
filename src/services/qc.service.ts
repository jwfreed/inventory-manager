import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import { qcEventSchema, qcWarehouseDispositionSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { createNcr } from './ncr.service';
import { resolveDefaultLocationForRole, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  buildTransferLockTargets,
  buildTransferReplayResult,
  executeTransferInventoryMutation,
  prepareTransferMutation,
  transferInventory,
  type PreparedTransferMutation
} from './transfers.service';
import { getDefaultSellableLocation, getHoldLocation, getQaLocation } from './locationResolvers.service';
import { runInventoryCommand } from '../modules/platform/application/runInventoryCommand';
import { buildReplayCorruptionError } from '../modules/platform/application/inventoryMutationSupport';
import { withInventoryTransaction } from '../modules/platform/application/withInventoryTransaction';
import {
  RECEIPT_ALLOCATION_STATUSES,
  moveReceiptAllocations,
  type ValidatedReceiptAllocationMutationContext
} from '../domain/receipts/receiptAllocationModel';
import { validateOrRebuildReceiptAllocationsForMutation } from '../domain/receipts/receiptAllocationRebuilder';
import { resolveInventoryBin } from '../domain/receipts/receiptBinModel';
import { evaluateQcCommand } from '../domain/receipts/receiptCommands';

export type QcEventInput = z.infer<typeof qcEventSchema>;
export type QcWarehouseDispositionInput = z.infer<typeof qcWarehouseDispositionSchema>;
type QcEventSourceType = 'receipt' | 'work_order' | 'execution_line';

type CreateQcEventResult = {
  eventId: string;
  event: ReturnType<typeof mapQcEvent>;
  movementId: string | null;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  sourceWarehouseId: string | null;
  destinationWarehouseId: string | null;
  replayed: boolean;
};

type CreateQcEventCommandParams = {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  idempotencyKey: string | null;
  requestHash: string | null;
};

type QcPreparedWorkflowState = {
  sourceType: QcEventSourceType;
  sourceId: string;
  itemId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  sourceBinId: string;
  destinationBinId: string;
  preparedTransfer: PreparedTransferMutation;
};

type ReceiptQcWorkflowState = QcPreparedWorkflowState & {
  sourceType: 'receipt';
  receiptId: string;
  receiptLineId: string;
  allocationContext: ValidatedReceiptAllocationMutationContext;
};

type WorkOrderQcWorkflowState = QcPreparedWorkflowState & {
  sourceType: 'work_order';
  workOrderId: string;
};

type ExecutionLineQcWorkflowState = QcPreparedWorkflowState & {
  sourceType: 'execution_line';
  executionLineId: string;
};

type QcTransferExecution = Awaited<ReturnType<typeof executeTransferInventoryMutation>>;

function qcRetryDebugEnabled() {
  return process.env.NODE_ENV === 'test' || process.env.DEBUG_QC_TX_RETRY === 'true';
}

function logQcRetry(event: string, payload: Record<string, unknown>) {
  if (!qcRetryDebugEnabled()) {
    return;
  }
  console.warn(`[qc.tx.${event}]`, payload);
}

function mapQcEvent(row: any) {
  return {
    id: row.id,
    purchaseOrderReceiptLineId: row.purchase_order_receipt_line_id,
    workOrderId: row.work_order_id,
    workOrderExecutionLineId: row.work_order_execution_line_id,
    eventType: row.event_type,
    quantity: roundQuantity(toNumber(row.quantity)),
    uom: row.uom,
    reasonCode: row.reason_code,
    notes: row.notes,
    actorType: row.actor_type,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

async function moveReceiptAllocationsFromQa(params: {
  client: any;
  tenantId: string;
  receiptLineId: string;
  quantity: number;
  sourceBinId?: string | null;
  destinationLocationId: string;
  destinationBinId: string;
  movementId: string;
  movementLineId: string;
  occurredAt: Date;
  destinationStatus: typeof RECEIPT_ALLOCATION_STATUSES[keyof typeof RECEIPT_ALLOCATION_STATUSES];
  allocationContext: ValidatedReceiptAllocationMutationContext;
}) {
  try {
    await moveReceiptAllocations({
      client: params.client,
      tenantId: params.tenantId,
      context: params.allocationContext,
      receiptLineId: params.receiptLineId,
      quantity: params.quantity,
      sourceStatus: RECEIPT_ALLOCATION_STATUSES.QA,
      sourceBinId: params.sourceBinId,
      destinationLocationId: params.destinationLocationId,
      destinationBinId: params.destinationBinId,
      movementId: params.movementId,
      movementLineId: params.movementLineId,
      occurredAt: params.occurredAt,
      destinationStatus: params.destinationStatus
    });
  } catch (error) {
    if ((error as Error).message === 'RECEIPT_ALLOCATION_PRECHECK_FAILED') {
      throw new Error('QC_RECEIPT_ALLOCATION_INSUFFICIENT_QA');
    }
    throw error;
  }
}

async function resolveWarehouseRootIdByRef(
  tenantId: string,
  warehouseRef: string,
  client: {
    query: (
      sql: string,
      params: unknown[]
    ) => Promise<{ rowCount: number | null; rows: Array<{ id: string }> }>;
  }
): Promise<string | null> {
  const ref = warehouseRef.trim();
  if (!ref) return null;
  const res = await client.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND type = 'warehouse'
        AND (id::text = $2 OR code = $2)
      ORDER BY id
      LIMIT 1`,
    [tenantId, ref]
  );
  return (res.rowCount ?? 0) > 0 ? res.rows[0].id : null;
}

function resolveCreateQcEventSourceType(data: QcEventInput): QcEventSourceType {
  if (data.purchaseOrderReceiptLineId) return 'receipt';
  if (data.workOrderExecutionLineId) return 'execution_line';
  if (data.workOrderId) return 'work_order';
  throw new Error('QC_SOURCE_REQUIRED');
}

function buildQcTransferNotes(params: {
  sourceType: QcEventSourceType;
  sourceId: string;
  eventType: QcEventInput['eventType'];
}) {
  if (params.sourceType === 'receipt' && params.eventType === 'hold') {
    return `QC hold for receipt line ${params.sourceId}`;
  }
  if (params.sourceType === 'receipt' && params.eventType === 'reject') {
    return `QC reject for receipt line ${params.sourceId}`;
  }
  return `QC ${params.eventType} for ${params.sourceType} ${params.sourceId}`;
}

async function prepareQcTransferWorkflowState(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  idempotencyKey: string | null;
  client: any;
  sourceType: QcEventSourceType;
  sourceId: string;
  itemId: string | null;
  locationId: string | null;
}): Promise<QcPreparedWorkflowState> {
  if (!params.locationId) throw new Error('QC_LOCATION_REQUIRED');
  if (!params.itemId) throw new Error('QC_ITEM_ID_REQUIRED');

  const destinationRole =
    params.data.eventType === 'accept' ? 'SELLABLE' : params.data.eventType === 'hold' ? 'HOLD' : 'REJECT';
  const reasonCode =
    params.data.eventType === 'accept' ? 'qc_release' : params.data.eventType === 'hold' ? 'qc_hold' : 'qc_reject';
  const notes = buildQcTransferNotes({
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    eventType: params.data.eventType
  });

  let sourceLocationId: string;
  try {
    sourceLocationId = await resolveDefaultLocationForRole(params.tenantId, params.locationId, 'QA', params.client);
  } catch (error) {
    if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
      throw new Error('QC_QA_LOCATION_REQUIRED');
    }
    throw error;
  }

  let destinationLocationId: string;
  try {
    destinationLocationId = await resolveDefaultLocationForRole(
      params.tenantId,
      params.locationId,
      destinationRole,
      params.client
    );
  } catch (error) {
    if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
      if (params.data.eventType === 'accept') throw new Error('QC_ACCEPT_LOCATION_REQUIRED');
      if (params.data.eventType === 'hold') throw new Error('QC_HOLD_LOCATION_REQUIRED');
      throw new Error('QC_REJECT_LOCATION_REQUIRED');
    }
    throw error;
  }

  const sourceWarehouseId = await resolveWarehouseIdForLocation(params.tenantId, sourceLocationId, params.client);
  const sourceBinId = (
    await resolveInventoryBin({
      client: params.client,
      tenantId: params.tenantId,
      warehouseId: sourceWarehouseId,
      locationId: sourceLocationId,
      binId: params.data.sourceBinId ?? null,
      allowDefaultBinResolution: true
    })
  ).id;
  const destinationWarehouseId = await resolveWarehouseIdForLocation(
    params.tenantId,
    destinationLocationId,
    params.client
  );
  const destinationBinId = (
    await resolveInventoryBin({
      client: params.client,
      tenantId: params.tenantId,
      warehouseId: destinationWarehouseId,
      locationId: destinationLocationId,
      binId: params.data.destinationBinId ?? null,
      allowDefaultBinResolution: true
    })
  ).id;

  const preparedTransfer = await prepareTransferMutation(
    {
      tenantId: params.tenantId,
      sourceLocationId,
      destinationLocationId,
      itemId: params.itemId,
      quantity: params.enteredQty,
      uom: params.data.uom,
      sourceType: 'qc_event',
      sourceId: params.qcEventId,
      movementType: 'transfer',
      qcAction: params.data.eventType,
      reasonCode,
      notes,
      occurredAt: params.occurredAt,
      actorId: params.data.actorId ?? null,
      overrideNegative: params.data.overrideNegative,
      overrideReason: params.data.overrideReason ?? null,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:transfer` : null
    },
    params.client
  );

  return {
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    itemId: params.itemId,
    sourceLocationId,
    destinationLocationId,
    sourceBinId,
    destinationBinId,
    preparedTransfer
  };
}

async function replayQcEventResult(params: {
  tenantId: string;
  idempotencyKey: string | null;
  client: any;
  responseBody: CreateQcEventResult;
}) {
  const qcEventResult = await params.client.query(
    `SELECT *
       FROM qc_events
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE`,
    [params.tenantId, params.responseBody.eventId]
  );
  if (qcEventResult.rowCount === 0) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'qc_event',
      aggregateId: params.responseBody.eventId,
      reason: 'qc_event_missing'
    });
  }
  if (
    params.responseBody.movementId
    && params.responseBody.sourceWarehouseId
    && params.responseBody.destinationWarehouseId
  ) {
    await buildTransferReplayResult({
      tenantId: params.tenantId,
      movementId: params.responseBody.movementId,
      normalizedIdempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:transfer` : null,
      replayed: true,
      client: params.client,
      sourceLocationId: params.responseBody.sourceLocationId,
      destinationLocationId: params.responseBody.destinationLocationId,
      itemId: params.responseBody.itemId,
      quantity: params.responseBody.quantity,
      uom: params.responseBody.uom,
      sourceWarehouseId: params.responseBody.sourceWarehouseId,
      destinationWarehouseId: params.responseBody.destinationWarehouseId,
      expectedLineCount: 2
    });
  }
  return {
    ...params.responseBody,
    event: mapQcEvent(qcEventResult.rows[0]),
    replayed: true
  };
}

async function replayReceiptQcEvent(params: {
  tenantId: string;
  idempotencyKey: string | null;
  client: any;
  responseBody: CreateQcEventResult;
}) {
  return replayQcEventResult(params);
}

async function replayWorkOrderQcEvent(params: {
  tenantId: string;
  idempotencyKey: string | null;
  client: any;
  responseBody: CreateQcEventResult;
}) {
  return replayQcEventResult(params);
}

async function replayExecutionLineQcEvent(params: {
  tenantId: string;
  idempotencyKey: string | null;
  client: any;
  responseBody: CreateQcEventResult;
}) {
  return replayQcEventResult(params);
}

async function insertQcEventRow(params: {
  tenantId: string;
  qcEventId: string;
  data: QcEventInput;
  enteredQty: number;
  occurredAt: Date;
  sourceBinId: string;
  destinationBinId: string;
  client: any;
}) {
  const { rows } = await params.client.query(
    `INSERT INTO qc_events (
        id, tenant_id, purchase_order_receipt_line_id, work_order_id, work_order_execution_line_id,
        event_type, quantity, uom, reason_code, notes, actor_type, actor_id, occurred_at, created_at,
        source_bin_id, destination_bin_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $15)
     RETURNING *`,
    [
      params.qcEventId,
      params.tenantId,
      params.data.purchaseOrderReceiptLineId ?? null,
      params.data.workOrderId ?? null,
      params.data.workOrderExecutionLineId ?? null,
      params.data.eventType,
      params.enteredQty,
      params.data.uom,
      params.data.reasonCode ?? null,
      params.data.notes ?? null,
      params.data.actorType,
      params.data.actorId ?? null,
      params.occurredAt,
      params.sourceBinId,
      params.destinationBinId
    ]
  );
  return rows[0];
}

async function recordQcEventAudit(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  occurredAt: Date;
  createdId: string;
  sourceType: QcEventSourceType;
  sourceId: string;
  client: any;
}) {
  await recordAuditLog(
    {
      tenantId: params.tenantId,
      actorType: params.data.actorType,
      actorId: params.data.actorId ?? null,
      action: 'create',
      entityType: 'qc_event',
      entityId: params.createdId,
      occurredAt: params.occurredAt,
      metadata: {
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        eventType: params.data.eventType,
        quantity: params.enteredQty,
        uom: params.data.uom,
        reasonCode: params.data.reasonCode ?? null
      }
    },
    params.client
  );
}

async function executeQcTransferBoundary(params: {
  tenantId: string;
  qcEventId: string;
  occurredAt: Date;
  workflowState: QcPreparedWorkflowState;
  client: any;
  lockContext: any;
}) {
  const transferExecution = await executeTransferInventoryMutation(
    params.workflowState.preparedTransfer,
    params.client,
    params.lockContext
  );
  await params.client.query(
    `INSERT INTO qc_inventory_links (
        id, tenant_id, qc_event_id, inventory_movement_id, created_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (qc_event_id) DO NOTHING`,
    [uuidv4(), params.tenantId, params.qcEventId, transferExecution.result.movementId, params.occurredAt]
  );
  return transferExecution;
}

async function recordQcNegativeOverrideAuditIfNeeded(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  occurredAt: Date;
  createdId: string;
  workflowState: QcPreparedWorkflowState;
  transferExecution: QcTransferExecution;
  client: any;
}) {
  if (!params.transferExecution.result.created || !params.data.actorType) {
    return;
  }
  const validation = await params.client.query(`SELECT metadata FROM inventory_movements WHERE id = $1`, [
    params.transferExecution.result.movementId
  ]);
  const metadata = validation.rows[0]?.metadata;
  if (!metadata?.override_requested) {
    return;
  }
  await recordAuditLog(
    {
      tenantId: params.tenantId,
      actorType: params.data.actorType,
      actorId: params.data.actorId ?? null,
      action: 'negative_override',
      entityType: 'inventory_movement',
      entityId: params.transferExecution.result.movementId,
      occurredAt: params.occurredAt,
      metadata: {
        reason: metadata.override_reason ?? null,
        reference: metadata.override_reference ?? null,
        qcEventId: params.createdId,
        itemId: params.workflowState.itemId,
        locationId: params.workflowState.sourceLocationId,
        uom: params.data.uom,
        quantity: params.enteredQty
      }
    },
    params.client
  );
}

function buildCreateQcEventExecutionResult(params: {
  created: any;
  data: QcEventInput;
  enteredQty: number;
  workflowState: QcPreparedWorkflowState;
  transferExecution: QcTransferExecution;
}) {
  return {
    responseBody: {
      eventId: params.created.id,
      event: mapQcEvent(params.created),
      movementId: params.transferExecution.result.movementId,
      sourceLocationId: params.workflowState.sourceLocationId,
      destinationLocationId: params.workflowState.destinationLocationId,
      itemId: params.workflowState.itemId,
      quantity: params.enteredQty,
      uom: params.data.uom,
      sourceWarehouseId: params.workflowState.preparedTransfer.sourceWarehouseId,
      destinationWarehouseId: params.workflowState.preparedTransfer.destinationWarehouseId,
      replayed: !params.transferExecution.result.created
    },
    responseStatus: params.transferExecution.result.created ? 201 : 200,
    events: params.transferExecution.events,
    projectionOps: params.transferExecution.projectionOps
  };
}

async function executeBaseQcWorkflow(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  workflowState: QcPreparedWorkflowState;
  client: any;
  lockContext: any;
}) {
  const created = await insertQcEventRow({
    tenantId: params.tenantId,
    qcEventId: params.qcEventId,
    data: params.data,
    enteredQty: params.enteredQty,
    occurredAt: params.occurredAt,
    sourceBinId: params.workflowState.sourceBinId,
    destinationBinId: params.workflowState.destinationBinId,
    client: params.client
  });
  await recordQcEventAudit({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    occurredAt: params.occurredAt,
    createdId: created.id,
    sourceType: params.workflowState.sourceType,
    sourceId: params.workflowState.sourceId,
    client: params.client
  });
  if (params.data.eventType === 'reject' && params.workflowState.sourceType === 'receipt') {
    await createNcr(params.tenantId, created.id, params.client);
  }
  const transferExecution = await executeQcTransferBoundary({
    tenantId: params.tenantId,
    qcEventId: created.id,
    occurredAt: params.occurredAt,
    workflowState: params.workflowState,
    client: params.client,
    lockContext: params.lockContext
  });
  await recordQcNegativeOverrideAuditIfNeeded({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    occurredAt: params.occurredAt,
    createdId: created.id,
    workflowState: params.workflowState,
    transferExecution,
    client: params.client
  });
  return { created, transferExecution };
}

async function prepareReceiptQcWorkflowState(
  params: CreateQcEventCommandParams & { client: any }
): Promise<ReceiptQcWorkflowState> {
  const receiptLineId = params.data.purchaseOrderReceiptLineId;
  if (!receiptLineId) {
    throw new Error('QC_SOURCE_REQUIRED');
  }

  const lineResult = await params.client.query(
    `SELECT prl.id,
            prl.uom,
            prl.quantity_received,
            prl.purchase_order_receipt_id,
            por.received_to_location_id,
            por.status AS receipt_status,
            pol.item_id
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
       JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
      WHERE prl.id = $1 AND prl.tenant_id = $2
      FOR UPDATE`,
    [receiptLineId, params.tenantId]
  );
  if (lineResult.rowCount === 0) throw new Error('QC_LINE_NOT_FOUND');
  const line = lineResult.rows[0];
  if (line.receipt_status === 'voided') throw new Error('QC_RECEIPT_VOIDED');
  if (line.receipt_status !== 'posted') throw new Error('QC_RECEIPT_NOT_ELIGIBLE');
  if (line.uom !== params.data.uom) throw new Error('QC_UOM_MISMATCH');

  const totalResult = await params.client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM qc_events
      WHERE purchase_order_receipt_line_id = $1
        AND tenant_id = $2`,
    [receiptLineId, params.tenantId]
  );
  const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
  const lineQuantity = toNumber(line.quantity_received);
  if (currentTotal + params.enteredQty - lineQuantity > 1e-6) {
    throw new Error('QC_EXCEEDS_RECEIPT');
  }

  const workflowState = await prepareQcTransferWorkflowState({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    idempotencyKey: params.idempotencyKey,
    client: params.client,
    sourceType: 'receipt',
    sourceId: receiptLineId,
    itemId: line.item_id,
    locationId: line.received_to_location_id
  });
  const allocationContext = await validateOrRebuildReceiptAllocationsForMutation({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: line.purchase_order_receipt_id,
    requirements: [
      {
        receiptLineId,
        requiredStatus: RECEIPT_ALLOCATION_STATUSES.QA,
        requiredBinId: workflowState.sourceBinId,
        requiredQuantity: params.enteredQty
      }
    ],
    occurredAt: params.occurredAt
  });

  return {
    ...workflowState,
    sourceType: 'receipt',
    sourceId: receiptLineId,
    receiptId: line.purchase_order_receipt_id,
    receiptLineId,
    allocationContext
  };
}

async function prepareWorkOrderQcWorkflowState(
  params: CreateQcEventCommandParams & { client: any }
): Promise<WorkOrderQcWorkflowState> {
  const workOrderId = params.data.workOrderId;
  if (!workOrderId) {
    throw new Error('QC_SOURCE_REQUIRED');
  }

  const woResult = await params.client.query(
    `SELECT id, output_uom, output_item_id, quantity_completed, default_produce_location_id
       FROM work_orders
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [workOrderId, params.tenantId]
  );
  if (woResult.rowCount === 0) throw new Error('QC_WORK_ORDER_NOT_FOUND');
  const workOrder = woResult.rows[0];
  if (workOrder.output_uom !== params.data.uom) throw new Error('QC_UOM_MISMATCH');

  if (workOrder.quantity_completed !== null) {
    const totalResult = await params.client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM qc_events
        WHERE work_order_id = $1
          AND tenant_id = $2`,
      [workOrderId, params.tenantId]
    );
    const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
    const workOrderQuantity = toNumber(workOrder.quantity_completed);
    if (currentTotal + params.enteredQty - workOrderQuantity > 1e-6) {
      throw new Error('QC_EXCEEDS_WORK_ORDER');
    }
  }

  const workflowState = await prepareQcTransferWorkflowState({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    idempotencyKey: params.idempotencyKey,
    client: params.client,
    sourceType: 'work_order',
    sourceId: workOrderId,
    itemId: workOrder.output_item_id,
    locationId: workOrder.default_produce_location_id
  });

  return {
    ...workflowState,
    sourceType: 'work_order',
    sourceId: workOrderId,
    workOrderId
  };
}

async function prepareExecutionLineQcWorkflowState(
  params: CreateQcEventCommandParams & { client: any }
): Promise<ExecutionLineQcWorkflowState> {
  const executionLineId = params.data.workOrderExecutionLineId;
  if (!executionLineId) {
    throw new Error('QC_SOURCE_REQUIRED');
  }

  const lineResult = await params.client.query(
    `SELECT wel.id, wel.uom, wel.quantity, wel.item_id, wel.to_location_id, we.status
       FROM work_order_execution_lines wel
       JOIN work_order_executions we ON we.id = wel.work_order_execution_id
      WHERE wel.id = $1 AND we.tenant_id = $2
      FOR UPDATE`,
    [executionLineId, params.tenantId]
  );
  if (lineResult.rowCount === 0) throw new Error('QC_EXECUTION_LINE_NOT_FOUND');
  const line = lineResult.rows[0];
  if (line.uom !== params.data.uom) throw new Error('QC_UOM_MISMATCH');

  const totalResult = await params.client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM qc_events
      WHERE work_order_execution_line_id = $1
        AND tenant_id = $2`,
    [executionLineId, params.tenantId]
  );
  const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
  const lineQuantity = toNumber(line.quantity);
  if (currentTotal + params.enteredQty - lineQuantity > 1e-6) {
    throw new Error('QC_EXCEEDS_EXECUTION');
  }

  const workflowState = await prepareQcTransferWorkflowState({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    idempotencyKey: params.idempotencyKey,
    client: params.client,
    sourceType: 'execution_line',
    sourceId: executionLineId,
    itemId: line.item_id,
    locationId: line.to_location_id
  });

  return {
    ...workflowState,
    sourceType: 'execution_line',
    sourceId: executionLineId,
    executionLineId
  };
}

async function applyReceiptQcSideEffects(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  occurredAt: Date;
  workflowState: ReceiptQcWorkflowState;
  transferExecution: QcTransferExecution;
  client: any;
}) {
  const receiptResult = await params.client.query(
    `SELECT purchase_order_receipt_id
       FROM purchase_order_receipt_lines
      WHERE id = $1
        AND tenant_id = $2`,
    [params.workflowState.receiptLineId, params.tenantId]
  );
  const receiptId = receiptResult.rows[0]?.purchase_order_receipt_id;
  if (!receiptId) {
    throw new Error('QC_LINE_NOT_FOUND');
  }

  const movementLineResult = await params.client.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE movement_id = $1
        AND tenant_id = $2
        AND quantity_delta > 0
      ORDER BY COALESCE(event_timestamp, created_at) DESC, id DESC
      LIMIT 1`,
    [params.transferExecution.result.movementId, params.tenantId]
  );
  const movementLineId = movementLineResult.rows[0]?.id;
  if (!movementLineId) {
    throw new Error('QC_TRANSFER_LINE_MISSING');
  }

  await moveReceiptAllocationsFromQa({
    client: params.client,
    tenantId: params.tenantId,
    receiptLineId: params.workflowState.receiptLineId,
    quantity: params.enteredQty,
    sourceBinId: params.workflowState.sourceBinId,
    destinationLocationId: params.workflowState.destinationLocationId,
    destinationBinId: params.workflowState.destinationBinId,
    movementId: params.transferExecution.result.movementId,
    movementLineId,
    occurredAt: params.occurredAt,
    allocationContext: params.workflowState.allocationContext,
    destinationStatus:
      params.data.eventType === 'accept'
        ? RECEIPT_ALLOCATION_STATUSES.AVAILABLE
        : RECEIPT_ALLOCATION_STATUSES.HOLD
  });

  const lifecycleGuard = await params.client.query(
    `WITH receipt_qc AS (
        SELECT prl.purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0)::numeric AS accept_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0)::numeric AS hold_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0)::numeric AS reject_qty,
               COALESCE(SUM(prl.quantity_received), 0)::numeric AS received_qty
          FROM purchase_order_receipt_lines prl
          LEFT JOIN qc_events qe
            ON qe.purchase_order_receipt_line_id = prl.id
           AND qe.tenant_id = prl.tenant_id
         WHERE prl.purchase_order_receipt_id = $1
           AND prl.tenant_id = $2
         GROUP BY prl.purchase_order_receipt_id
      ),
      dispositions AS (
        SELECT prl.purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(hde.quantity), 0)::numeric AS total_disposed,
               COALESCE(SUM(CASE WHEN hde.disposition_type = 'release' THEN hde.quantity ELSE 0 END), 0)::numeric AS released_qty
          FROM purchase_order_receipt_lines prl
          JOIN hold_disposition_events hde
            ON hde.purchase_order_receipt_line_id = prl.id
           AND hde.tenant_id = prl.tenant_id
         WHERE prl.purchase_order_receipt_id = $1
           AND prl.tenant_id = $2
         GROUP BY prl.purchase_order_receipt_id
      )
      SELECT por.lifecycle_state,
             rq.received_qty,
             rq.accept_qty,
             rq.hold_qty,
             rq.reject_qty,
             COALESCE(d.total_disposed, 0) AS total_disposed,
             COALESCE(d.released_qty, 0) AS released_qty
        FROM purchase_order_receipts por
        JOIN receipt_qc rq
          ON rq.receipt_id = por.id
        LEFT JOIN dispositions d ON d.receipt_id = por.id
       WHERE por.id = $1
         AND por.tenant_id = $2`,
    [receiptId, params.tenantId]
  );
  const guardRow = lifecycleGuard.rows[0];
  if (!guardRow) {
    throw new Error('RECEIPT_NOT_FOUND');
  }

  const totalReceived = roundQuantity(toNumber(guardRow.received_qty ?? 0));
  const totalAccept = roundQuantity(toNumber(guardRow.accept_qty ?? 0));
  const grossHold = roundQuantity(toNumber(guardRow.hold_qty ?? 0));
  const totalReject = roundQuantity(toNumber(guardRow.reject_qty ?? 0));
  const totalDisposed = roundQuantity(toNumber(guardRow.total_disposed ?? 0));
  const releasedQty = roundQuantity(toNumber(guardRow.released_qty ?? 0));

  const netHold = roundQuantity(grossHold - totalDisposed);
  const effectiveAccept = roundQuantity(totalAccept + releasedQty);

  await evaluateQcCommand({
    client: params.client,
    tenantId: params.tenantId,
    receiptId,
    occurredAt: params.occurredAt,
    currentState: guardRow.lifecycle_state,
    qcComplete: totalReceived > 0 && totalReceived - (totalAccept + grossHold + totalReject) <= 1e-6,
    acceptedQty: effectiveAccept,
    heldQty: netHold,
    rejectedQty: totalReject,
    receivedQty: totalReceived
  });
}

async function executeReceiptQcEvent(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  workflowState: ReceiptQcWorkflowState;
  client: any;
  lockContext: any;
}) {
  const { created, transferExecution } = await executeBaseQcWorkflow({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    workflowState: params.workflowState,
    client: params.client,
    lockContext: params.lockContext
  });

  await applyReceiptQcSideEffects({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    occurredAt: params.occurredAt,
    workflowState: params.workflowState,
    transferExecution,
    client: params.client
  });

  return buildCreateQcEventExecutionResult({
    created,
    data: params.data,
    enteredQty: params.enteredQty,
    workflowState: params.workflowState,
    transferExecution
  });
}

async function executeWorkOrderQcEvent(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  workflowState: WorkOrderQcWorkflowState;
  client: any;
  lockContext: any;
}) {
  const { created, transferExecution } = await executeBaseQcWorkflow({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    workflowState: params.workflowState,
    client: params.client,
    lockContext: params.lockContext
  });

  return buildCreateQcEventExecutionResult({
    created,
    data: params.data,
    enteredQty: params.enteredQty,
    workflowState: params.workflowState,
    transferExecution
  });
}

async function executeExecutionLineQcEvent(params: {
  tenantId: string;
  data: QcEventInput;
  enteredQty: number;
  qcEventId: string;
  occurredAt: Date;
  workflowState: ExecutionLineQcWorkflowState;
  client: any;
  lockContext: any;
}) {
  const { created, transferExecution } = await executeBaseQcWorkflow({
    tenantId: params.tenantId,
    data: params.data,
    enteredQty: params.enteredQty,
    qcEventId: params.qcEventId,
    occurredAt: params.occurredAt,
    workflowState: params.workflowState,
    client: params.client,
    lockContext: params.lockContext
  });

  return buildCreateQcEventExecutionResult({
    created,
    data: params.data,
    enteredQty: params.enteredQty,
    workflowState: params.workflowState,
    transferExecution
  });
}

async function createReceiptQcEvent(params: CreateQcEventCommandParams) {
  const sourceId = params.data.purchaseOrderReceiptLineId ?? '';
  const sourceType: QcEventSourceType = 'receipt';
  let workflowState: ReceiptQcWorkflowState | null = null;

  try {
    return await runInventoryCommand<CreateQcEventResult>({
      tenantId: params.tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.QC_EVENTS_CREATE,
      operation: 'qc_event_create',
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      retryOptions: {
        isolationLevel: 'SERIALIZABLE',
        retries: 2,
        onRetry: ({ attempt, sqlState, delayMs }) => {
          logQcRetry('retry', {
            tenantId: params.tenantId,
            sourceId,
            sourceType,
            eventType: params.data.eventType,
            attempt,
            sqlState,
            delayMs
          });
        }
      },
      onReplay: async ({ client, responseBody }) =>
        replayReceiptQcEvent({
          tenantId: params.tenantId,
          idempotencyKey: params.idempotencyKey,
          client,
          responseBody
        }),
      lockTargets: async (client) => {
        workflowState = await prepareReceiptQcWorkflowState({ ...params, client });
        return buildTransferLockTargets(workflowState.preparedTransfer);
      },
      execute: async ({ client, lockContext }) => {
        if (!workflowState) {
          throw new Error('QC_PREPARE_REQUIRED');
        }
        return executeReceiptQcEvent({
          tenantId: params.tenantId,
          data: params.data,
          enteredQty: params.enteredQty,
          qcEventId: params.qcEventId,
          occurredAt: params.occurredAt,
          workflowState,
          client,
          lockContext
        });
      }
    });
  } catch (error: any) {
    if (error?.code === 'TX_RETRY_EXHAUSTED') {
      logQcRetry('exhausted', {
        tenantId: params.tenantId,
        sourceId,
        sourceType,
        eventType: params.data.eventType,
        sqlState: typeof error?.retrySqlState === 'string' ? error.retrySqlState : null,
        attempts: Number.isFinite(Number(error?.retryAttempts)) ? Number(error.retryAttempts) : null
      });
    }
    throw error;
  }
}

async function createWorkOrderQcEvent(params: CreateQcEventCommandParams) {
  const sourceId = params.data.workOrderId ?? '';
  const sourceType: QcEventSourceType = 'work_order';
  let workflowState: WorkOrderQcWorkflowState | null = null;

  try {
    return await runInventoryCommand<CreateQcEventResult>({
      tenantId: params.tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.QC_EVENTS_CREATE,
      operation: 'qc_event_create',
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      retryOptions: {
        isolationLevel: 'SERIALIZABLE',
        retries: 2,
        onRetry: ({ attempt, sqlState, delayMs }) => {
          logQcRetry('retry', {
            tenantId: params.tenantId,
            sourceId,
            sourceType,
            eventType: params.data.eventType,
            attempt,
            sqlState,
            delayMs
          });
        }
      },
      onReplay: async ({ client, responseBody }) =>
        replayWorkOrderQcEvent({
          tenantId: params.tenantId,
          idempotencyKey: params.idempotencyKey,
          client,
          responseBody
        }),
      lockTargets: async (client) => {
        workflowState = await prepareWorkOrderQcWorkflowState({ ...params, client });
        return buildTransferLockTargets(workflowState.preparedTransfer);
      },
      execute: async ({ client, lockContext }) => {
        if (!workflowState) {
          throw new Error('QC_PREPARE_REQUIRED');
        }
        return executeWorkOrderQcEvent({
          tenantId: params.tenantId,
          data: params.data,
          enteredQty: params.enteredQty,
          qcEventId: params.qcEventId,
          occurredAt: params.occurredAt,
          workflowState,
          client,
          lockContext
        });
      }
    });
  } catch (error: any) {
    if (error?.code === 'TX_RETRY_EXHAUSTED') {
      logQcRetry('exhausted', {
        tenantId: params.tenantId,
        sourceId,
        sourceType,
        eventType: params.data.eventType,
        sqlState: typeof error?.retrySqlState === 'string' ? error.retrySqlState : null,
        attempts: Number.isFinite(Number(error?.retryAttempts)) ? Number(error.retryAttempts) : null
      });
    }
    throw error;
  }
}

async function createExecutionLineQcEvent(params: CreateQcEventCommandParams) {
  const sourceId = params.data.workOrderExecutionLineId ?? '';
  const sourceType: QcEventSourceType = 'execution_line';
  let workflowState: ExecutionLineQcWorkflowState | null = null;

  try {
    return await runInventoryCommand<CreateQcEventResult>({
      tenantId: params.tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.QC_EVENTS_CREATE,
      operation: 'qc_event_create',
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      retryOptions: {
        isolationLevel: 'SERIALIZABLE',
        retries: 2,
        onRetry: ({ attempt, sqlState, delayMs }) => {
          logQcRetry('retry', {
            tenantId: params.tenantId,
            sourceId,
            sourceType,
            eventType: params.data.eventType,
            attempt,
            sqlState,
            delayMs
          });
        }
      },
      onReplay: async ({ client, responseBody }) =>
        replayExecutionLineQcEvent({
          tenantId: params.tenantId,
          idempotencyKey: params.idempotencyKey,
          client,
          responseBody
        }),
      lockTargets: async (client) => {
        workflowState = await prepareExecutionLineQcWorkflowState({ ...params, client });
        return buildTransferLockTargets(workflowState.preparedTransfer);
      },
      execute: async ({ client, lockContext }) => {
        if (!workflowState) {
          throw new Error('QC_PREPARE_REQUIRED');
        }
        return executeExecutionLineQcEvent({
          tenantId: params.tenantId,
          data: params.data,
          enteredQty: params.enteredQty,
          qcEventId: params.qcEventId,
          occurredAt: params.occurredAt,
          workflowState,
          client,
          lockContext
        });
      }
    });
  } catch (error: any) {
    if (error?.code === 'TX_RETRY_EXHAUSTED') {
      logQcRetry('exhausted', {
        tenantId: params.tenantId,
        sourceId,
        sourceType,
        eventType: params.data.eventType,
        sqlState: typeof error?.retrySqlState === 'string' ? error.retrySqlState : null,
        attempts: Number.isFinite(Number(error?.retryAttempts)) ? Number(error.retryAttempts) : null
      });
    }
    throw error;
  }
}

export async function createQcEvent(
  tenantId: string,
  data: QcEventInput,
  options?: { idempotencyKey?: string | null }
) {
  const enteredQty = roundQuantity(toNumber(data.quantity));
  const qcEventId = uuidv4();
  const occurredAt = new Date();
  const idempotencyKey = options?.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const requestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.QC_EVENTS_CREATE,
        body: {
          purchaseOrderReceiptLineId: data.purchaseOrderReceiptLineId ?? null,
          workOrderId: data.workOrderId ?? null,
          workOrderExecutionLineId: data.workOrderExecutionLineId ?? null,
          eventType: data.eventType,
          quantity: enteredQty,
          uom: data.uom,
          overrideNegative: data.overrideNegative ?? false,
          overrideReason: data.overrideReason ?? null,
          reasonCode: data.reasonCode ?? null,
          notes: data.notes ?? null,
          actorType: data.actorType,
          actorId: data.actorId ?? null
        }
      })
    : null;

  const commandParams: CreateQcEventCommandParams = {
    tenantId,
    data,
    enteredQty,
    qcEventId,
    occurredAt,
    idempotencyKey,
    requestHash
  };
  const sourceType = resolveCreateQcEventSourceType(data);
  if (sourceType === 'receipt') {
    return createReceiptQcEvent(commandParams);
  }
  if (sourceType === 'work_order') {
    return createWorkOrderQcEvent(commandParams);
  }
  return createExecutionLineQcEvent(commandParams);
}

export async function postQcWarehouseDisposition(
  tenantId: string,
  action: 'accept' | 'reject',
  data: QcWarehouseDispositionInput,
  actor: { type: 'user' | 'system'; id?: string | null },
  options?: { idempotencyKey?: string | null }
) {
  const quantity = toNumber(data.quantity);
  if (!(quantity > 0)) {
    throw new Error('QC_INVALID_QUANTITY');
  }
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : null;
  if (occurredAt && Number.isNaN(occurredAt.getTime())) {
    throw new Error('QC_INVALID_OCCURRED_AT');
  }
  const idempotencyKey = options?.idempotencyKey?.trim() || data.idempotencyKey?.trim() || null;
  const warehouseId = await resolveWarehouseRootIdByRef(tenantId, data.warehouseId, {
    query: (sql, params) => query(sql, params)
  });
  if (!warehouseId) {
    throw new Error('QC_WAREHOUSE_NOT_FOUND');
  }

  const sourceLocationId = await getQaLocation(tenantId, warehouseId);
  if (!sourceLocationId) {
    throw new Error('QC_QA_LOCATION_REQUIRED');
  }
  const destinationLocationId = action === 'accept'
    ? await getDefaultSellableLocation(tenantId, warehouseId)
    : await getHoldLocation(tenantId, warehouseId);
  if (!destinationLocationId) {
    throw new Error(action === 'accept' ? 'QC_ACCEPT_LOCATION_REQUIRED' : 'QC_HOLD_LOCATION_REQUIRED');
  }

  const sourceId = idempotencyKey
    ? `qc_wrapper:${action}:${idempotencyKey}`
    : `qc_wrapper:${action}:${uuidv4()}`;
  const transfer = await withInventoryTransaction(async (client) => {
    const t = await transferInventory({
      tenantId,
      warehouseId,
      sourceLocationId,
      destinationLocationId,
      itemId: data.itemId,
      quantity,
      uom: data.uom,
      sourceType: 'qc_event',
      sourceId,
      movementType: 'transfer',
      qcAction: action === 'accept' ? 'accept' : 'hold',
      reasonCode: action === 'accept' ? 'QC_ACCEPT' : 'QC_REJECT',
      notes: data.notes?.trim() || `QC ${action} warehouse disposition`,
      occurredAt: occurredAt ?? undefined,
      actorId: actor.id ?? null,
      overrideNegative: data.overrideNegative,
      overrideReason: data.overrideReason ?? null,
      idempotencyKey,
      inventoryCommandEndpoint:
        action === 'accept' ? IDEMPOTENCY_ENDPOINTS.QC_WAREHOUSE_ACCEPT : IDEMPOTENCY_ENDPOINTS.QC_WAREHOUSE_REJECT,
      inventoryCommandOperation: action === 'accept' ? 'qc_accept_disposition' : 'qc_reject_disposition',
      inventoryCommandRequestBody: {
        action,
        warehouseId: data.warehouseId,
        itemId: data.itemId,
        quantity: roundQuantity(quantity),
        uom: data.uom,
        notes: data.notes?.trim() || null,
        overrideNegative: data.overrideNegative ?? false,
        overrideReason: data.overrideReason ?? null,
        occurredAt: occurredAt ?? undefined
      }
    }, { client });
    if (!t.replayed) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: action === 'accept' ? 'qc_accept' : 'qc_reject',
          entityId: t.movementId,
          occurredAt: occurredAt ?? undefined,
          metadata: {
            warehouseId,
            sourceLocationId,
            destinationLocationId,
            itemId: data.itemId,
            quantity,
            uom: data.uom
          }
        },
        client
      );
    }
    return t;
  });

  return {
    action,
    movementId: transfer.movementId,
    warehouseId,
    sourceLocationId,
    destinationLocationId,
    itemId: data.itemId,
    quantity: roundQuantity(quantity),
    uom: data.uom,
    idempotencyKey,
    replayed: transfer.replayed
  };
}

export async function listQcEventsForLine(tenantId: string, lineId: string) {
  const lineResult = await query('SELECT id FROM purchase_order_receipt_lines WHERE id = $1 AND tenant_id = $2', [
    lineId,
    tenantId
  ]);
  if (lineResult.rowCount === 0) {
    throw new Error('QC_LINE_NOT_FOUND');
  }
  const { rows } = await query(
    `SELECT * FROM qc_events
       WHERE purchase_order_receipt_line_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
    [lineId, tenantId]
  );
  return rows.map(mapQcEvent);
}

export async function getQcEventById(tenantId: string, id: string) {
  const { rows } = await query('SELECT * FROM qc_events WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (rows.length === 0) return null;
  return mapQcEvent(rows[0]);
}

export async function listQcEventsForWorkOrder(tenantId: string, workOrderId: string) {
  const woResult = await query('SELECT id FROM work_orders WHERE id = $1 AND tenant_id = $2', [workOrderId, tenantId]);
  if (woResult.rowCount === 0) {
    throw new Error('QC_WORK_ORDER_NOT_FOUND');
  }
  const { rows } = await query(
    `SELECT * FROM qc_events
       WHERE work_order_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
    [workOrderId, tenantId]
  );
  return rows.map(mapQcEvent);
}

export async function listQcEventsForExecutionLine(tenantId: string, lineId: string) {
  const lineResult = await query(
    `SELECT wel.id 
       FROM work_order_execution_lines wel
       JOIN work_order_executions we ON we.id = wel.work_order_execution_id
      WHERE wel.id = $1 AND we.tenant_id = $2`,
    [lineId, tenantId]
  );
  if (lineResult.rowCount === 0) {
    throw new Error('QC_EXECUTION_LINE_NOT_FOUND');
  }
  const { rows } = await query(
    `SELECT * FROM qc_events
       WHERE work_order_execution_line_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
    [lineId, tenantId]
  );
  return rows.map(mapQcEvent);
}
