import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { qcEventSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';
import { recordAuditLog } from '../lib/audit';
import { createNcr, findMrbLocation } from './ncr.service';

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
      if (line.uom !== data.uom) throw new Error('QC_UOM_MISMATCH');
      
      itemId = line.item_id;
      locationId = line.received_to_location_id;

      const totalResult = await client.query(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM qc_events WHERE purchase_order_receipt_line_id = $1 AND tenant_id = $2',
        [sourceId, tenantId]
      );
      const normalized = normalizeQuantityByUom(data.quantity, data.uom);
      const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
      const lineQuantity = roundQuantity(toNumber(line.quantity_received));
      if (roundQuantity(currentTotal + normalized.quantity) - lineQuantity > 1e-6) {
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
      const normalized = normalizeQuantityByUom(data.quantity, data.uom);
      const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
      const lineQuantity = roundQuantity(toNumber(line.quantity));
      if (roundQuantity(currentTotal + normalized.quantity) - lineQuantity > 1e-6) {
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
        const normalized = normalizeQuantityByUom(data.quantity, data.uom);
        const currentTotal = roundQuantity(toNumber(totalResult.rows[0]?.total ?? 0));
        const woQuantity = roundQuantity(toNumber(wo.quantity_completed));
        if (roundQuantity(currentTotal + normalized.quantity) - woQuantity > 1e-6) {
          throw new Error('QC_EXCEEDS_WORK_ORDER');
        }
      }
    } else {
      throw new Error('QC_SOURCE_REQUIRED');
    }

    const normalized = normalizeQuantityByUom(data.quantity, data.uom);

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
        normalized.quantity,
        normalized.uom,
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
          quantity: normalized.quantity,
          uom: normalized.uom,
          reasonCode: data.reasonCode ?? null
        }
      },
      client
    );

    if (data.eventType === 'accept' || data.eventType === 'reject') {
      let targetLocationId: string | null = null;
      let movementType = 'receive';
      let reasonCode = 'qc_release';
      let notes = `QC ${data.eventType} for receipt line ${sourceId}`;

      if (data.eventType === 'reject') {
        targetLocationId = await findMrbLocation(tenantId, client);
        if (!targetLocationId) {
          throw new Error('QC_MRB_LOCATION_REQUIRED');
        }
        await createNcr(tenantId, created.id, client);
        reasonCode = 'qc_reject_mrb';
        notes = `QC reject to MRB for receipt line ${sourceId}`;
      } else {
        // Accept logic
        if (itemId) {
          const itemResult = await client.query(
            'SELECT default_location_id FROM items WHERE id = $1 AND tenant_id = $2',
            [itemId, tenantId]
          );
          targetLocationId = itemResult.rows[0]?.default_location_id ?? null;
        }
      }
      
      const sourceLocationId = locationId;
      const destLocationId = targetLocationId ?? sourceLocationId;

      if (sourceType === 'receipt') {
        // PO Receipt: Create new inventory (Receive)
        const loc = destLocationId; // For receipt, we receive INTO the target (Stock or MRB)
        if (!loc) throw new Error('QC_LOCATION_REQUIRED');
        
        const now = new Date();
        const movementId = uuidv4();
        await client.query(
          `INSERT INTO inventory_movements (
              id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
           ) VALUES ($1, $2, 'receive', 'posted', $3, $4, $4, $5, $4, $4)`,
          [movementId, tenantId, `qc_${data.eventType}:${created.id}`, now, notes]
        );
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            uuidv4(),
            tenantId,
            movementId,
            itemId,
            loc,
            normalized.quantity,
            normalized.uom,
            reasonCode,
            `QC ${data.eventType} ${normalized.quantity} ${normalized.uom}`
          ]
        );
        await client.query(
          `INSERT INTO qc_inventory_links (
              id, tenant_id, qc_event_id, inventory_movement_id, created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), tenantId, created.id, movementId, now]
        );
      } else if (sourceLocationId && destLocationId && sourceLocationId !== destLocationId) {
         // WO / Execution: Transfer inventory
         const now = new Date();
         const movementId = uuidv4();
         await client.query(
            `INSERT INTO inventory_movements (
                id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
             ) VALUES ($1, $2, 'transfer', 'posted', $3, $4, $4, $5, $4, $4)`,
            [movementId, tenantId, `qc_${data.eventType}:${created.id}`, now, notes]
          );
          await client.query(
            `INSERT INTO inventory_movement_lines (
                id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              uuidv4(),
              tenantId,
              movementId,
              itemId,
              sourceLocationId,
              -normalized.quantity,
              normalized.uom,
              `${reasonCode}_out`,
              `QC ${data.eventType} transfer out`
            ]
          );
           await client.query(
            `INSERT INTO inventory_movement_lines (
                id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              uuidv4(),
              tenantId,
              movementId,
              itemId,
              destLocationId,
              normalized.quantity,
              normalized.uom,
              `${reasonCode}_in`,
              `QC ${data.eventType} transfer in`
            ]
          );
          await client.query(
            `INSERT INTO qc_inventory_links (
                id, tenant_id, qc_event_id, inventory_movement_id, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), tenantId, created.id, movementId, now]
          );
      }
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
