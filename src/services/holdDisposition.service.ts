import { v4 as uuidv4 } from 'uuid';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import {
  buildTransferLockTargets,
  buildTransferReplayResult,
  executeTransferInventoryMutation,
  prepareTransferMutation,
  type PreparedTransferMutation
} from './transfers.service';
import { resolveDefaultLocationForRole, resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { runInventoryCommand } from '../modules/platform/application/runInventoryCommand';
import { buildReplayCorruptionError } from '../modules/platform/application/inventoryMutationSupport';
import {
  RECEIPT_ALLOCATION_STATUSES,
  moveReceiptAllocations,
  validateReceiptAllocationMutationContext,
  type ValidatedReceiptAllocationMutationContext
} from '../domain/receipts/receiptAllocationModel';
import { resolveInventoryBin } from '../domain/receipts/receiptBinModel';
import { evaluateQcCommand } from '../domain/receipts/receiptCommands';

export type HoldDispositionType = 'release' | 'rework' | 'discard';

export type HoldDispositionInput = {
  purchaseOrderReceiptLineId: string;
  dispositionType: HoldDispositionType;
  quantity: number;
  uom: string;
  reasonCode?: string | null;
  notes?: string | null;
  actorType: 'user' | 'system';
  actorId?: string | null;
  sourceBinId?: string | null;
  destinationBinId?: string | null;
};

export type HoldDispositionResult = {
  eventId: string;
  receiptLineId: string;
  dispositionType: HoldDispositionType;
  quantity: number;
  uom: string;
  movementId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  replayed: boolean;
};

type HoldDispositionWorkflowState = {
  eventId: string;
  receiptId: string;
  receiptLineId: string;
  itemId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceBinId: string;
  destinationBinId: string;
  preparedTransfer: PreparedTransferMutation;
  allocationContext: ValidatedReceiptAllocationMutationContext;
};

type WarehouseDefaultRole = 'SELLABLE' | 'QA' | 'HOLD' | 'REJECT' | 'SCRAP';

function destinationRoleForDispositionType(dispositionType: HoldDispositionType): WarehouseDefaultRole {
  if (dispositionType === 'release') return 'SELLABLE';
  // WP3: rework and discard share REJECT location role as a temporary simplification.
  // Physical separation of rework staging vs. discard staging is a WP4 concern.
  // The semantic distinction is preserved via disposition_type in hold_disposition_events.
  return 'REJECT';
}

function allocationStatusForDispositionType(
  dispositionType: HoldDispositionType
): typeof RECEIPT_ALLOCATION_STATUSES[keyof typeof RECEIPT_ALLOCATION_STATUSES] {
  if (dispositionType === 'release') return RECEIPT_ALLOCATION_STATUSES.AVAILABLE;
  if (dispositionType === 'rework') return RECEIPT_ALLOCATION_STATUSES.REWORK;
  return RECEIPT_ALLOCATION_STATUSES.DISCARDED;
}

async function prepareHoldDispositionWorkflowState(params: {
  tenantId: string;
  data: HoldDispositionInput;
  enteredQty: number;
  eventId: string;
  occurredAt: Date;
  idempotencyKey: string | null;
  client: any;
}): Promise<HoldDispositionWorkflowState> {
  const receiptLineId = params.data.purchaseOrderReceiptLineId;

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
  if (lineResult.rowCount === 0) throw new Error('HOLD_DISPOSITION_LINE_NOT_FOUND');
  const line = lineResult.rows[0];
  if (line.receipt_status === 'voided') throw new Error('HOLD_DISPOSITION_RECEIPT_VOIDED');
  if (line.receipt_status !== 'posted') throw new Error('HOLD_DISPOSITION_RECEIPT_NOT_ELIGIBLE');
  if (line.uom !== params.data.uom) throw new Error('HOLD_DISPOSITION_UOM_MISMATCH');

  const holdResult = await params.client.query(
    `SELECT
        COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0)::numeric AS gross_hold,
        COALESCE((
          SELECT SUM(hde.quantity)
            FROM hold_disposition_events hde
           WHERE hde.purchase_order_receipt_line_id = $1
             AND hde.tenant_id = $2
        ), 0)::numeric AS already_disposed
       FROM qc_events qe
      WHERE qe.purchase_order_receipt_line_id = $1
        AND qe.tenant_id = $2`,
    [receiptLineId, params.tenantId]
  );
  const grossHold = roundQuantity(toNumber(holdResult.rows[0]?.gross_hold ?? 0));
  const alreadyDisposed = roundQuantity(toNumber(holdResult.rows[0]?.already_disposed ?? 0));
  const netHeld = roundQuantity(grossHold - alreadyDisposed);

  if (params.enteredQty - netHeld > 1e-6) {
    throw new Error('HOLD_DISPOSITION_EXCEEDS_HELD');
  }
  if (netHeld <= 1e-6) {
    throw new Error('HOLD_DISPOSITION_NO_HELD_QUANTITY');
  }

  const warehouseRef = line.received_to_location_id;
  if (!warehouseRef) throw new Error('HOLD_DISPOSITION_LOCATION_REQUIRED');

  let sourceLocationId: string;
  try {
    sourceLocationId = await resolveDefaultLocationForRole(params.tenantId, warehouseRef, 'HOLD', params.client);
  } catch (error) {
    if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
      throw new Error('HOLD_DISPOSITION_HOLD_LOCATION_REQUIRED');
    }
    throw error;
  }

  const destinationRole = destinationRoleForDispositionType(params.data.dispositionType);
  let destinationLocationId: string;
  try {
    destinationLocationId = await resolveDefaultLocationForRole(
      params.tenantId,
      warehouseRef,
      destinationRole,
      params.client
    );
  } catch (error) {
    if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
      throw new Error(`HOLD_DISPOSITION_${destinationRole}_LOCATION_REQUIRED`);
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

  const reasonCode =
    params.data.reasonCode ??
    (params.data.dispositionType === 'release'
      ? 'hold_release'
      : params.data.dispositionType === 'rework'
        ? 'hold_rework'
        : 'hold_discard');
  const notes =
    params.data.notes ??
    `Hold ${params.data.dispositionType} for receipt line ${receiptLineId}`;

  const preparedTransfer = await prepareTransferMutation(
    {
      tenantId: params.tenantId,
      sourceLocationId,
      destinationLocationId,
      itemId: line.item_id,
      quantity: params.enteredQty,
      uom: params.data.uom,
      sourceType: 'hold_disposition',
      sourceId: params.eventId,
      movementType: 'transfer',
      reasonCode,
      notes,
      occurredAt: params.occurredAt,
      actorId: params.data.actorId ?? null,
      overrideNegative: false,
      overrideReason: null,
      idempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:transfer` : null
    },
    params.client
  );

  const allocationContext = await validateReceiptAllocationMutationContext({
    client: params.client,
    tenantId: params.tenantId,
    requirements: [
      {
        receiptLineId,
        requiredStatus: RECEIPT_ALLOCATION_STATUSES.HOLD,
        requiredBinId: sourceBinId,
        requiredQuantity: params.enteredQty
      }
    ]
  });

  return {
    eventId: params.eventId,
    receiptId: line.purchase_order_receipt_id,
    receiptLineId,
    itemId: line.item_id,
    sourceLocationId,
    destinationLocationId,
    sourceWarehouseId,
    destinationWarehouseId,
    sourceBinId,
    destinationBinId,
    preparedTransfer,
    allocationContext
  };
}

async function executeHoldDispositionWorkflow(params: {
  tenantId: string;
  data: HoldDispositionInput;
  enteredQty: number;
  occurredAt: Date;
  workflowState: HoldDispositionWorkflowState;
  client: any;
  lockContext: any;
}): Promise<{ responseBody: HoldDispositionResult; responseStatus: number; events: any[]; projectionOps: any[] }> {
  const transferExecution = await executeTransferInventoryMutation(
    params.workflowState.preparedTransfer,
    params.client,
    params.lockContext
  );

  const movementLineResult = await params.client.query(
    `SELECT id
       FROM inventory_movement_lines
      WHERE movement_id = $1
        AND tenant_id = $2
        AND quantity_delta > 0
      ORDER BY COALESCE(event_timestamp, created_at) DESC, id DESC
      LIMIT 1`,
    [transferExecution.result.movementId, params.tenantId]
  );
  const movementLineId = movementLineResult.rows[0]?.id;
  if (!movementLineId) {
    throw new Error('HOLD_DISPOSITION_TRANSFER_LINE_MISSING');
  }

  const destinationStatus = allocationStatusForDispositionType(params.data.dispositionType);
  await moveReceiptAllocations({
    client: params.client,
    tenantId: params.tenantId,
    context: params.workflowState.allocationContext,
    receiptLineId: params.workflowState.receiptLineId,
    quantity: params.enteredQty,
    sourceStatus: RECEIPT_ALLOCATION_STATUSES.HOLD,
    sourceBinId: params.workflowState.sourceBinId,
    destinationLocationId: params.workflowState.destinationLocationId,
    destinationBinId: params.workflowState.destinationBinId,
    destinationStatus,
    movementId: transferExecution.result.movementId,
    movementLineId,
    occurredAt: params.occurredAt
  });

  await params.client.query(
    `INSERT INTO hold_disposition_events (
        id, tenant_id, purchase_order_receipt_line_id,
        inventory_movement_id, disposition_type, quantity, uom,
        reason_code, notes, actor_type, actor_id, occurred_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      params.workflowState.eventId,
      params.tenantId,
      params.workflowState.receiptLineId,
      transferExecution.result.movementId,
      params.data.dispositionType,
      params.enteredQty,
      params.data.uom,
      params.data.reasonCode ?? null,
      params.data.notes ?? null,
      params.data.actorType,
      params.data.actorId ?? null,
      params.occurredAt
    ]
  );

  await recordAuditLog(
    {
      tenantId: params.tenantId,
      actorType: params.data.actorType,
      actorId: params.data.actorId ?? null,
      action: 'create',
      entityType: 'hold_disposition_event',
      entityId: params.workflowState.eventId,
      occurredAt: params.occurredAt,
      metadata: {
        receiptLineId: params.workflowState.receiptLineId,
        dispositionType: params.data.dispositionType,
        quantity: params.enteredQty,
        uom: params.data.uom,
        movementId: transferExecution.result.movementId,
        reasonCode: params.data.reasonCode ?? null
      }
    },
    params.client
  );

  await evaluateQcAfterDisposition({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.workflowState.receiptId,
    occurredAt: params.occurredAt
  });

  return {
    responseBody: {
      eventId: params.workflowState.eventId,
      receiptLineId: params.workflowState.receiptLineId,
      dispositionType: params.data.dispositionType,
      quantity: params.enteredQty,
      uom: params.data.uom,
      movementId: transferExecution.result.movementId,
      sourceLocationId: params.workflowState.sourceLocationId,
      destinationLocationId: params.workflowState.destinationLocationId,
      sourceWarehouseId: params.workflowState.sourceWarehouseId,
      destinationWarehouseId: params.workflowState.destinationWarehouseId,
      replayed: !transferExecution.result.created
    },
    responseStatus: transferExecution.result.created ? 201 : 200,
    events: transferExecution.events ?? [],
    projectionOps: transferExecution.projectionOps ?? []
  };
}

async function evaluateQcAfterDisposition(params: {
  client: any;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
}) {
  const lifecycleGuard = await params.client.query(
    `WITH receipt_lines AS (
        SELECT purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(quantity_received), 0)::numeric AS received_qty
          FROM purchase_order_receipt_lines
         WHERE purchase_order_receipt_id = $1
           AND tenant_id = $2
         GROUP BY purchase_order_receipt_id
      ),
      receipt_qc AS (
        SELECT prl.purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0)::numeric AS accept_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0)::numeric AS hold_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0)::numeric AS reject_qty
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
               COALESCE(SUM(CASE WHEN hde.disposition_type = 'release' THEN hde.quantity ELSE 0 END), 0)::numeric AS released_qty,
               COALESCE(SUM(CASE WHEN hde.disposition_type = 'rework' THEN hde.quantity ELSE 0 END), 0)::numeric AS reworked_qty
          FROM purchase_order_receipt_lines prl
          JOIN hold_disposition_events hde
            ON hde.purchase_order_receipt_line_id = prl.id
           AND hde.tenant_id = prl.tenant_id
         WHERE prl.purchase_order_receipt_id = $1
           AND prl.tenant_id = $2
         GROUP BY prl.purchase_order_receipt_id
      )
      SELECT por.lifecycle_state,
             rl.received_qty,
             rq.accept_qty,
             rq.hold_qty,
             rq.reject_qty,
             COALESCE(d.total_disposed, 0) AS total_disposed,
             COALESCE(d.released_qty, 0) AS released_qty,
             COALESCE(d.reworked_qty, 0) AS reworked_qty
        FROM purchase_order_receipts por
        JOIN receipt_lines rl ON rl.receipt_id = por.id
        JOIN receipt_qc rq ON rq.receipt_id = por.id
        LEFT JOIN dispositions d ON d.receipt_id = por.id
       WHERE por.id = $1
         AND por.tenant_id = $2`,
    [params.receiptId, params.tenantId]
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
  const reworkedQty = roundQuantity(toNumber(guardRow.reworked_qty ?? 0));

  const netHold = roundQuantity(grossHold - totalDisposed);
  const effectiveAccept = roundQuantity(totalAccept + releasedQty);

  await evaluateQcCommand({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    occurredAt: params.occurredAt,
    currentState: guardRow.lifecycle_state,
    qcComplete: totalReceived > 0 && totalReceived - (totalAccept + grossHold + totalReject) <= 1e-6,
    acceptedQty: effectiveAccept,
    heldQty: netHold,
    rejectedQty: totalReject,
    receivedQty: totalReceived,
    reworkedQty
  });
}

async function replayHoldDisposition(params: {
  tenantId: string;
  idempotencyKey: string | null;
  client: any;
  responseBody: HoldDispositionResult;
}): Promise<HoldDispositionResult> {
  const eventResult = await params.client.query(
    `SELECT id
       FROM hold_disposition_events
      WHERE tenant_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE`,
    [params.tenantId, params.responseBody.eventId]
  );
  if (eventResult.rowCount === 0) {
    throw buildReplayCorruptionError({
      tenantId: params.tenantId,
      aggregateType: 'hold_disposition_event',
      aggregateId: params.responseBody.eventId,
      reason: 'hold_disposition_event_missing'
    });
  }
  if (params.responseBody.movementId) {
    await buildTransferReplayResult({
      tenantId: params.tenantId,
      movementId: params.responseBody.movementId,
      normalizedIdempotencyKey: params.idempotencyKey ? `${params.idempotencyKey}:transfer` : null,
      replayed: true,
      client: params.client,
      sourceLocationId: params.responseBody.sourceLocationId,
      destinationLocationId: params.responseBody.destinationLocationId,
      itemId: '',
      quantity: params.responseBody.quantity,
      uom: params.responseBody.uom,
      sourceWarehouseId: params.responseBody.sourceWarehouseId,
      destinationWarehouseId: params.responseBody.destinationWarehouseId,
      expectedLineCount: 2
    });
  }
  return { ...params.responseBody, replayed: true };
}

export async function resolveHoldDisposition(
  tenantId: string,
  data: HoldDispositionInput,
  options: { idempotencyKey?: string | null; occurredAt?: Date } = {}
): Promise<HoldDispositionResult> {
  const enteredQty = roundQuantity(data.quantity);
  if (enteredQty <= 1e-6) {
    throw new Error('HOLD_DISPOSITION_QUANTITY_INVALID');
  }

  const eventId = uuidv4();
  const occurredAt = options.occurredAt ?? new Date();
  const idempotencyKey = options.idempotencyKey?.trim() ? options.idempotencyKey.trim() : null;
  const requestHash = idempotencyKey
    ? hashTransactionalIdempotencyRequest({
        method: 'POST',
        endpoint: IDEMPOTENCY_ENDPOINTS.HOLD_DISPOSITION_CREATE,
        body: {
          purchaseOrderReceiptLineId: data.purchaseOrderReceiptLineId,
          dispositionType: data.dispositionType,
          quantity: enteredQty,
          uom: data.uom,
          actorType: data.actorType ?? null,
          actorId: data.actorId ?? null,
          reasonCode: data.reasonCode ?? null,
          notes: data.notes ?? null
        }
      })
    : null;

  let workflowState: HoldDispositionWorkflowState | null = null;

  const result = await runInventoryCommand<HoldDispositionResult>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.HOLD_DISPOSITION_CREATE,
    operation: 'hold_disposition_create',
    idempotencyKey,
    requestHash,
    retryOptions: {
      isolationLevel: 'SERIALIZABLE',
      retries: 2
    },
    onReplay: async ({ client, responseBody }) =>
      replayHoldDisposition({ tenantId, idempotencyKey, client, responseBody }),
    lockTargets: async (client) => {
      workflowState = await prepareHoldDispositionWorkflowState({
        tenantId,
        data,
        enteredQty,
        eventId,
        occurredAt,
        idempotencyKey,
        client
      });
      return buildTransferLockTargets(workflowState.preparedTransfer);
    },
    execute: async ({ client, lockContext }) => {
      if (!workflowState) {
        throw new Error('HOLD_DISPOSITION_PREPARE_REQUIRED');
      }
      return executeHoldDispositionWorkflow({
        tenantId,
        data,
        enteredQty,
        occurredAt,
        workflowState,
        client,
        lockContext
      });
    }
  });

  return result;
}
