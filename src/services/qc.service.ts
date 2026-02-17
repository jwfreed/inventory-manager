import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { qcEventSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { beginIdempotency, completeIdempotency, hashRequestBody } from '../lib/idempotencyStore';
import { createNcr } from './ncr.service';
import { resolveDefaultLocationForRole } from './warehouseDefaults.service';
import { transferInventory } from './transfers.service';

export type QcEventInput = z.infer<typeof qcEventSchema>;

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

export async function createQcEvent(tenantId: string, data: QcEventInput) {
  return withTransaction(async (client) => {
    let itemId: string | null = null;
    let locationId: string | null = null;
    let sourceId: string | null = null;
    let sourceType: 'receipt' | 'work_order' | 'execution_line' = 'receipt';

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
      const enteredQty = toNumber(data.quantity);
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
      const enteredQty = toNumber(data.quantity);
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
          WHERE id = $1 AND tenant_id = $2`,
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
        const enteredQty = toNumber(data.quantity);
        const currentTotal = toNumber(totalResult.rows[0]?.total ?? 0);
        const woQuantity = toNumber(wo.quantity_completed);
        if (currentTotal + enteredQty - woQuantity > 1e-6) {
          throw new Error('QC_EXCEEDS_WORK_ORDER');
        }
      }
    } else {
      throw new Error('QC_SOURCE_REQUIRED');
    }

    const enteredQty = toNumber(data.quantity);

    const { rows } = await client.query(
      `INSERT INTO qc_events (
          id, tenant_id, purchase_order_receipt_line_id, work_order_id, work_order_execution_line_id,
          event_type, quantity, uom, reason_code, notes, actor_type, actor_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        uuidv4(),
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
        data.actorId ?? null
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
        occurredAt: created.occurred_at ? new Date(created.occurred_at) : new Date(),
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

    if (data.eventType === 'accept' || data.eventType === 'reject' || data.eventType === 'hold') {
      if (!locationId) throw new Error('QC_LOCATION_REQUIRED');
      if (!itemId) throw new Error('QC_ITEM_ID_REQUIRED');

      const now = new Date();
      const action = data.eventType;
      const role = action === 'accept' ? 'SELLABLE' : action === 'hold' ? 'HOLD' : 'REJECT';
      const reasonCode = action === 'accept' ? 'qc_release' : action === 'hold' ? 'qc_hold' : 'qc_reject';
      let notes = `QC ${action} for ${sourceType} ${sourceId}`;

      if (action === 'reject' && sourceType === 'receipt') {
        await createNcr(tenantId, created.id, client);
        notes = `QC reject for receipt line ${sourceId}`;
      } else if (action === 'hold' && sourceType === 'receipt') {
        notes = `QC hold for receipt line ${sourceId}`;
      }

      let sourceLocationId: string;
      let destLocationId: string;
      try {
        sourceLocationId = await resolveDefaultLocationForRole(tenantId, locationId, 'QA', client);
      } catch (error) {
        if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
          throw new Error('QC_QA_LOCATION_REQUIRED');
        }
        throw error;
      }

      try {
        destLocationId = await resolveDefaultLocationForRole(tenantId, locationId, role, client);
      } catch (error) {
        if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
          if (action === 'accept') throw new Error('QC_ACCEPT_LOCATION_REQUIRED');
          if (action === 'hold') throw new Error('QC_HOLD_LOCATION_REQUIRED');
          throw new Error('QC_REJECT_LOCATION_REQUIRED');
        }
        throw error;
      }

      // QC disposition transfers existing inventory. Transfer posting relocates FIFO layers in the same transaction.
      const transferKey = `${created.id}:${action}`;
      const transferHash = hashRequestBody({
        qcEventId: created.id,
        action,
        itemId,
        sourceLocationId,
        destLocationId,
        quantity: enteredQty,
        uom: data.uom
      });
      const transferRecord = await beginIdempotency(transferKey, transferHash, client);
      if (transferRecord.status === 'SUCCEEDED') {
        let movementId: string | null = null;
        if (transferRecord.responseRef?.startsWith('inventory_movement:')) {
          movementId = transferRecord.responseRef.split(':')[1] ?? null;
        } else {
          const existingMovement = await client.query(
            `SELECT id
               FROM inventory_movements
              WHERE tenant_id = $1
                AND source_type = $2
                AND source_id = $3
                AND movement_type = $4
              LIMIT 1`,
            [tenantId, 'qc_event', created.id, 'transfer']
          );
          movementId = existingMovement.rows[0]?.id ?? null;
        }
        if (movementId) {
          await client.query(
            `INSERT INTO qc_inventory_links (id, tenant_id, qc_event_id, inventory_movement_id, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (qc_event_id) DO NOTHING`,
            [uuidv4(), tenantId, created.id, movementId, now]
          );
        }
        return mapQcEvent(created);
      }
      if (transferRecord.status === 'IN_PROGRESS' && !transferRecord.isNew) {
        throw new Error('QC_TRANSFER_IN_PROGRESS');
      }

      const transferResult = await transferInventory(
        {
          tenantId,
          sourceLocationId,
          destinationLocationId: destLocationId,
          itemId,
          quantity: enteredQty,
          uom: data.uom,
          sourceType: 'qc_event',
          sourceId: created.id,
          movementType: 'transfer',
          qcAction: action,
          reasonCode,
          notes,
          occurredAt: now,
          actorId: data.actorId,
          overrideNegative: data.overrideNegative,
          overrideReason: data.overrideReason ?? null
        },
        client
      );

      await client.query(
        `INSERT INTO qc_inventory_links (
            id, tenant_id, qc_event_id, inventory_movement_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (qc_event_id) DO NOTHING`,
        [uuidv4(), tenantId, created.id, transferResult.movementId, now]
      );

      if (transferResult.created && data.actorType) {
        const validation = await client.query(`SELECT metadata FROM inventory_movements WHERE id = $1`, [
          transferResult.movementId
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
              entityId: transferResult.movementId,
              occurredAt: now,
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

      await completeIdempotency(transferKey, 'SUCCEEDED', `inventory_movement:${transferResult.movementId}`, client);
    }

    return mapQcEvent(created);
  });
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
