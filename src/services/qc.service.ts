import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query } from '../db';
import { qcEventSchema, qcWarehouseDispositionSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { hashTransactionalIdempotencyRequest } from '../lib/transactionalIdempotency';
import { createNcr } from './ncr.service';
import { resolveDefaultLocationForRole } from './warehouseDefaults.service';
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

export type QcEventInput = z.infer<typeof qcEventSchema>;
export type QcWarehouseDispositionInput = z.infer<typeof qcWarehouseDispositionSchema>;
type QcEventSourceType = 'receipt' | 'work_order' | 'execution_line';

type CreateQcEventResult = {
  eventId: string;
  event: ReturnType<typeof mapQcEvent>;
  movementId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  quantity: number;
  uom: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  replayed: boolean;
};

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

  let itemId: string | null = null;
  let locationId: string | null = null;
  let sourceId: string | null = null;
  let sourceType: QcEventSourceType = 'receipt';
  let sourceLocationId: string | null = null;
  let destinationLocationId: string | null = null;
  let transferReasonCode: string | null = null;
  let transferNotes: string | null = null;
  let preparedTransfer: PreparedTransferMutation | null = null;

  try {
    return await runInventoryCommand<CreateQcEventResult>({
      tenantId,
      endpoint: IDEMPOTENCY_ENDPOINTS.QC_EVENTS_CREATE,
      operation: 'qc_event_create',
      idempotencyKey,
      requestHash,
      retryOptions: {
        isolationLevel: 'SERIALIZABLE',
        retries: 2,
        onRetry: ({ attempt, sqlState, delayMs }) => {
          logQcRetry('retry', {
            tenantId,
            sourceId,
            sourceType,
            eventType: data.eventType,
            attempt,
            sqlState,
            delayMs
          });
        }
      },
      onReplay: async ({ client, responseBody }) => {
      const qcEventResult = await client.query(
        `SELECT *
           FROM qc_events
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1
          FOR UPDATE`,
        [tenantId, responseBody.eventId]
      );
      if (qcEventResult.rowCount === 0) {
        throw buildReplayCorruptionError({
          tenantId,
          aggregateType: 'qc_event',
          aggregateId: responseBody.eventId,
          reason: 'qc_event_missing'
        });
      }
      await buildTransferReplayResult({
        tenantId,
        movementId: responseBody.movementId,
        normalizedIdempotencyKey: idempotencyKey ? `${idempotencyKey}:transfer` : null,
        replayed: true,
        client,
        sourceLocationId: responseBody.sourceLocationId,
        destinationLocationId: responseBody.destinationLocationId,
        itemId: responseBody.itemId,
        quantity: responseBody.quantity,
        uom: responseBody.uom,
        sourceWarehouseId: responseBody.sourceWarehouseId,
        destinationWarehouseId: responseBody.destinationWarehouseId,
        expectedLineCount: 2
      });
      return {
        ...responseBody,
        event: mapQcEvent(qcEventResult.rows[0]),
        replayed: true
      };
      },
      lockTargets: async (client) => {
      itemId = null;
      locationId = null;
      sourceId = null;
      sourceType = 'receipt';
      sourceLocationId = null;
      destinationLocationId = null;
      transferReasonCode = null;
      transferNotes = null;
      preparedTransfer = null;

      if (data.purchaseOrderReceiptLineId) {
        sourceId = data.purchaseOrderReceiptLineId;
        sourceType = 'receipt';
        const lineResult = await client.query(
          `SELECT prl.id,
                  prl.uom,
                  prl.quantity_received,
                  por.received_to_location_id,
                  por.status AS receipt_status,
                  pol.item_id
             FROM purchase_order_receipt_lines prl
             JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
             JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
            WHERE prl.id = $1 AND prl.tenant_id = $2
            FOR UPDATE`,
          [sourceId, tenantId]
        );
        if (lineResult.rowCount === 0) throw new Error('QC_LINE_NOT_FOUND');
        const line = lineResult.rows[0];
        if (line.receipt_status === 'voided') throw new Error('QC_RECEIPT_VOIDED');
        if (line.receipt_status !== 'posted') throw new Error('QC_RECEIPT_NOT_ELIGIBLE');
        if (line.uom !== data.uom) throw new Error('QC_UOM_MISMATCH');

        itemId = line.item_id;
        locationId = line.received_to_location_id;

        const totalResult = await client.query(
          'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE purchase_order_receipt_line_id = $1 AND tenant_id = $2',
          [sourceId, tenantId]
        );
        const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
        const lineQuantity = toNumber(line.quantity_received);
        if (currentTotal + enteredQty - lineQuantity > 1e-6) {
          throw new Error('QC_EXCEEDS_RECEIPT');
        }
      } else if (data.workOrderExecutionLineId) {
        sourceId = data.workOrderExecutionLineId;
        sourceType = 'execution_line';
        const lineResult = await client.query(
          `SELECT wel.id, wel.uom, wel.quantity, wel.item_id, wel.to_location_id, we.status
             FROM work_order_execution_lines wel
             JOIN work_order_executions we ON we.id = wel.work_order_execution_id
            WHERE wel.id = $1 AND we.tenant_id = $2
            FOR UPDATE`,
          [sourceId, tenantId]
        );
        if (lineResult.rowCount === 0) throw new Error('QC_EXECUTION_LINE_NOT_FOUND');
        const line = lineResult.rows[0];
        if (line.uom !== data.uom) throw new Error('QC_UOM_MISMATCH');

        itemId = line.item_id;
        locationId = line.to_location_id;

        const totalResult = await client.query(
          'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE work_order_execution_line_id = $1 AND tenant_id = $2',
          [sourceId, tenantId]
        );
        const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
        const lineQuantity = toNumber(line.quantity);
        if (currentTotal + enteredQty - lineQuantity > 1e-6) {
          throw new Error('QC_EXCEEDS_EXECUTION');
        }
      } else if (data.workOrderId) {
        sourceId = data.workOrderId;
        sourceType = 'work_order';
        const woResult = await client.query(
          `SELECT id, output_uom, output_item_id, quantity_completed, default_produce_location_id
             FROM work_orders
            WHERE id = $1 AND tenant_id = $2
            FOR UPDATE`,
          [sourceId, tenantId]
        );
        if (woResult.rowCount === 0) throw new Error('QC_WORK_ORDER_NOT_FOUND');
        const wo = woResult.rows[0];
        if (wo.output_uom !== data.uom) throw new Error('QC_UOM_MISMATCH');

        itemId = wo.output_item_id;
        locationId = wo.default_produce_location_id;

        if (wo.quantity_completed !== null) {
          const totalResult = await client.query(
            'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE work_order_id = $1 AND tenant_id = $2',
            [sourceId, tenantId]
          );
          const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
          const woQuantity = toNumber(wo.quantity_completed);
          if (currentTotal + enteredQty - woQuantity > 1e-6) {
            throw new Error('QC_EXCEEDS_WORK_ORDER');
          }
        }
      } else {
        throw new Error('QC_SOURCE_REQUIRED');
      }

      if (!locationId) throw new Error('QC_LOCATION_REQUIRED');
      if (!itemId) throw new Error('QC_ITEM_ID_REQUIRED');

      const destinationRole =
        data.eventType === 'accept' ? 'SELLABLE' : data.eventType === 'hold' ? 'HOLD' : 'REJECT';
      transferReasonCode =
        data.eventType === 'accept' ? 'qc_release' : data.eventType === 'hold' ? 'qc_hold' : 'qc_reject';
      transferNotes = `QC ${data.eventType} for ${sourceType} ${sourceId}`;

      if (data.eventType === 'hold' && sourceType === 'receipt') {
        transferNotes = `QC hold for receipt line ${sourceId}`;
      } else if (data.eventType === 'reject' && sourceType === 'receipt') {
        transferNotes = `QC reject for receipt line ${sourceId}`;
      }

      try {
        sourceLocationId = await resolveDefaultLocationForRole(tenantId, locationId, 'QA', client);
      } catch (error) {
        if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
          throw new Error('QC_QA_LOCATION_REQUIRED');
        }
        throw error;
      }

      try {
        destinationLocationId = await resolveDefaultLocationForRole(
          tenantId,
          locationId,
          destinationRole,
          client
        );
      } catch (error) {
        if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
          if (data.eventType === 'accept') throw new Error('QC_ACCEPT_LOCATION_REQUIRED');
          if (data.eventType === 'hold') throw new Error('QC_HOLD_LOCATION_REQUIRED');
          throw new Error('QC_REJECT_LOCATION_REQUIRED');
        }
        throw error;
      }

      preparedTransfer = await prepareTransferMutation(
        {
          tenantId,
          sourceLocationId,
          destinationLocationId,
          itemId,
          quantity: enteredQty,
          uom: data.uom,
          sourceType: 'qc_event',
          sourceId: qcEventId,
          movementType: 'transfer',
          qcAction: data.eventType,
          reasonCode: transferReasonCode,
          notes: transferNotes,
          occurredAt,
          actorId: data.actorId ?? null,
          overrideNegative: data.overrideNegative,
          overrideReason: data.overrideReason ?? null,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:transfer` : null
        },
        client
      );
      return buildTransferLockTargets(preparedTransfer);
      },
      execute: async ({ client }) => {
      if (!sourceId || !sourceLocationId || !destinationLocationId || !itemId || !preparedTransfer) {
        throw new Error('QC_PREPARE_REQUIRED');
      }

      const { rows } = await client.query(
        `INSERT INTO qc_events (
            id, tenant_id, purchase_order_receipt_line_id, work_order_id, work_order_execution_line_id,
            event_type, quantity, uom, reason_code, notes, actor_type, actor_id, occurred_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING *`,
        [
          qcEventId,
          tenantId,
          data.purchaseOrderReceiptLineId ?? null,
          data.workOrderId ?? null,
          data.workOrderExecutionLineId ?? null,
          data.eventType,
          enteredQty,
          data.uom,
          data.reasonCode ?? null,
          data.notes ?? null,
          data.actorType,
          data.actorId ?? null,
          occurredAt
        ]
      );
      const created = rows[0];

      await recordAuditLog(
        {
          tenantId,
          actorType: data.actorType,
          actorId: data.actorId ?? null,
          action: 'create',
          entityType: 'qc_event',
          entityId: created.id,
          occurredAt,
          metadata: {
            sourceType,
            sourceId,
            eventType: data.eventType,
            quantity: enteredQty,
            uom: data.uom,
            reasonCode: data.reasonCode ?? null
          }
        },
        client
      );

      if (data.eventType === 'reject' && sourceType === 'receipt') {
        await createNcr(tenantId, created.id, client);
      }

      const transferExecution = await executeTransferInventoryMutation(preparedTransfer, client);
      await client.query(
        `INSERT INTO qc_inventory_links (
            id, tenant_id, qc_event_id, inventory_movement_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (qc_event_id) DO NOTHING`,
        [uuidv4(), tenantId, created.id, transferExecution.result.movementId, occurredAt]
      );

      if (transferExecution.result.created && data.actorType) {
        const validation = await client.query(`SELECT metadata FROM inventory_movements WHERE id = $1`, [
          transferExecution.result.movementId
        ]);
        const metadata = validation.rows[0]?.metadata;
        if (metadata?.override_requested) {
          await recordAuditLog(
            {
              tenantId,
              actorType: data.actorType,
              actorId: data.actorId ?? null,
              action: 'negative_override',
              entityType: 'inventory_movement',
              entityId: transferExecution.result.movementId,
              occurredAt,
              metadata: {
                reason: metadata.override_reason ?? null,
                reference: metadata.override_reference ?? null,
                qcEventId: created.id,
                itemId,
                locationId: sourceLocationId,
                uom: data.uom,
                quantity: enteredQty
              }
            },
            client
          );
        }
      }

        return {
          responseBody: {
            eventId: created.id,
            event: mapQcEvent(created),
          movementId: transferExecution.result.movementId,
          sourceLocationId,
          destinationLocationId,
          itemId,
          quantity: enteredQty,
          uom: data.uom,
          sourceWarehouseId: preparedTransfer.sourceWarehouseId,
          destinationWarehouseId: preparedTransfer.destinationWarehouseId,
          replayed: !transferExecution.result.created
        },
        responseStatus: transferExecution.result.created ? 201 : 200,
        events: transferExecution.events,
        projectionOps: transferExecution.projectionOps
        };
      }
    });
  } catch (error: any) {
    if (error?.code === 'TX_RETRY_EXHAUSTED') {
      logQcRetry('exhausted', {
        tenantId,
        sourceId,
        sourceType,
        eventType: data.eventType,
        sqlState: typeof error?.retrySqlState === 'string' ? error.retrySqlState : null,
        attempts: Number.isFinite(Number(error?.retryAttempts)) ? Number(error.retryAttempts) : null
      });
    }
    throw error;
  }
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
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
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
  const transfer = await transferInventory({
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
    occurredAt,
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
      occurredAt: data.occurredAt ? new Date(data.occurredAt) : undefined
    }
  });

  await recordAuditLog({
    tenantId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: 'create',
    entityType: action === 'accept' ? 'qc_accept' : 'qc_reject',
    entityId: transfer.movementId,
    occurredAt,
    metadata: {
      warehouseId,
      sourceLocationId,
      destinationLocationId,
      itemId: data.itemId,
      quantity,
      uom: data.uom
    }
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
