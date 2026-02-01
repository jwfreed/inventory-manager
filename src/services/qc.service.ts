import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { qcEventSchema } from '../schemas/qc.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { createNcr } from './ncr.service';
import { calculateMovementCost } from './costing.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { validateSufficientStock } from './stockValidation.service';
import { resolveDefaultLocationForRole } from './warehouseDefaults.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';

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
      let targetLocationId: string | null = null;
      let reasonCode = 'qc_release';
      let notes = `QC ${data.eventType} for receipt line ${sourceId}`;

      if (sourceType === 'receipt') {
        if (data.eventType === 'reject') {
          if (!locationId) throw new Error('QC_LOCATION_REQUIRED');
          try {
            targetLocationId = await resolveDefaultLocationForRole(tenantId, locationId, 'REJECT', client);
          } catch (error) {
            if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
              throw new Error('QC_REJECT_LOCATION_REQUIRED');
            }
            throw error;
          }
          await createNcr(tenantId, created.id, client);
          reasonCode = 'qc_reject';
          notes = `QC reject for receipt line ${sourceId}`;
        } else if (data.eventType === 'hold') {
          if (!locationId) throw new Error('QC_LOCATION_REQUIRED');
          try {
            targetLocationId = await resolveDefaultLocationForRole(tenantId, locationId, 'HOLD', client);
          } catch (error) {
            if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
              throw new Error('QC_HOLD_LOCATION_REQUIRED');
            }
            throw error;
          }
          reasonCode = 'qc_hold';
          notes = `QC hold for receipt line ${sourceId}`;
        } else {
          if (!locationId) throw new Error('QC_LOCATION_REQUIRED');
          try {
            targetLocationId = await resolveDefaultLocationForRole(tenantId, locationId, 'SELLABLE', client);
          } catch (error) {
            if ((error as Error)?.message === 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED') {
              throw new Error('QC_ACCEPT_LOCATION_REQUIRED');
            }
            throw error;
          }
        }
      } else {
        targetLocationId = locationId;
      }
      
      const sourceLocationId = locationId;
      let destLocationId = targetLocationId ?? sourceLocationId;
      if (sourceType === 'receipt') {
        destLocationId = targetLocationId;
      }

      if (sourceType === 'receipt') {
        // PO Receipt: Reclassify inventory from QA to target location via transfer.
        // Valuation note: transfers do not create or mutate cost layers.
        if (!sourceLocationId) throw new Error('QC_LOCATION_REQUIRED');
        if (!destLocationId) throw new Error('QC_LOCATION_REQUIRED');
        if (!itemId) throw new Error('QC_ITEM_ID_REQUIRED');

        const now = new Date();
        if (sourceLocationId !== destLocationId) {
          const validation = await validateSufficientStock(
            tenantId,
            now,
            [
              {
                itemId,
                locationId: sourceLocationId,
                uom: data.uom,
                quantityToConsume: enteredQty
              }
            ],
            {
              actorId: data.actorId ?? null,
              overrideRequested: data.overrideNegative,
              overrideReason: data.overrideReason ?? null,
              overrideReference: `qc_${data.eventType}:${sourceId}`
            },
            { client }
          );
          const movementId = uuidv4();
          await createInventoryMovement(client, {
            id: movementId,
            tenantId,
            movementType: 'transfer',
            status: 'posted',
            externalRef: `qc_${data.eventType}:${created.id}`,
            sourceType: 'qc_event',
            sourceId: created.id,
            occurredAt: now,
            postedAt: now,
            notes,
            metadata: validation.overrideMetadata ?? null,
            createdAt: now,
            updatedAt: now
          });

          const canonicalOut = await getCanonicalMovementFields(
            tenantId,
            itemId,
            -enteredQty,
            data.uom,
            client
          );
          const costDataOut = await calculateMovementCost(
            tenantId,
            itemId,
            canonicalOut.quantityDeltaCanonical,
            client
          );
          await createInventoryMovementLine(client, {
            tenantId,
            movementId,
            itemId,
            locationId: sourceLocationId,
            quantityDelta: canonicalOut.quantityDeltaCanonical,
            uom: canonicalOut.canonicalUom,
            quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
            uomEntered: canonicalOut.uomEntered,
            quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
            canonicalUom: canonicalOut.canonicalUom,
            uomDimension: canonicalOut.uomDimension,
            unitCost: costDataOut.unitCost,
            extendedCost: costDataOut.extendedCost,
            reasonCode: `${reasonCode}_out`,
            lineNotes: `QC ${data.eventType} transfer out`
          });

          await applyInventoryBalanceDelta(client, {
            tenantId,
            itemId,
            locationId: sourceLocationId,
            uom: canonicalOut.canonicalUom,
            deltaOnHand: canonicalOut.quantityDeltaCanonical
          });

          const canonicalIn = await getCanonicalMovementFields(
            tenantId,
            itemId,
            enteredQty,
            data.uom,
            client
          );
          const costDataIn = await calculateMovementCost(
            tenantId,
            itemId,
            canonicalIn.quantityDeltaCanonical,
            client
          );
          await createInventoryMovementLine(client, {
            tenantId,
            movementId,
            itemId,
            locationId: destLocationId,
            quantityDelta: canonicalIn.quantityDeltaCanonical,
            uom: canonicalIn.canonicalUom,
            quantityDeltaEntered: canonicalIn.quantityDeltaEntered,
            uomEntered: canonicalIn.uomEntered,
            quantityDeltaCanonical: canonicalIn.quantityDeltaCanonical,
            canonicalUom: canonicalIn.canonicalUom,
            uomDimension: canonicalIn.uomDimension,
            unitCost: costDataIn.unitCost,
            extendedCost: costDataIn.extendedCost,
            reasonCode: `${reasonCode}_in`,
            lineNotes: `QC ${data.eventType} transfer in`
          });

          await applyInventoryBalanceDelta(client, {
            tenantId,
            itemId,
            locationId: destLocationId,
            uom: canonicalIn.canonicalUom,
            deltaOnHand: canonicalIn.quantityDeltaCanonical
          });
          await client.query(
            `INSERT INTO qc_inventory_links (
                id, tenant_id, qc_event_id, inventory_movement_id, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), tenantId, created.id, movementId, now]
          );

          await enqueueInventoryMovementPosted(client, tenantId, movementId);
          if (validation.overrideMetadata && data.actorType) {
            await recordAuditLog(
              {
                tenantId,
                actorType: data.actorType,
                actorId: data.actorId ?? null,
                action: 'negative_override',
                entityType: 'inventory_movement',
                entityId: movementId,
                occurredAt: now,
                metadata: {
                  reason: validation.overrideMetadata.override_reason ?? null,
                  reference: validation.overrideMetadata.override_reference ?? null,
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
      } else if (sourceLocationId && destLocationId && sourceLocationId !== destLocationId) {
         // WO / Execution: Transfer inventory
         if (!itemId) throw new Error('QC_ITEM_ID_REQUIRED');
         
         const now = new Date();
         const validation = await validateSufficientStock(
           tenantId,
           now,
           [
             {
               itemId,
               locationId: sourceLocationId,
               uom: data.uom,
               quantityToConsume: enteredQty
             }
           ],
           {
             actorId: data.actorId ?? null,
             overrideRequested: data.overrideNegative,
             overrideReason: data.overrideReason ?? null,
             overrideReference: `qc_${data.eventType}:${sourceId}`
           },
           { client }
         );
         const movementId = uuidv4();
         await createInventoryMovement(client, {
           id: movementId,
           tenantId,
           movementType: 'transfer',
           status: 'posted',
           externalRef: `qc_${data.eventType}:${created.id}`,
           sourceType: 'qc_event',
           sourceId: created.id,
           occurredAt: now,
           postedAt: now,
           notes,
           metadata: validation.overrideMetadata ?? null,
           createdAt: now,
           updatedAt: now
         });
          
          // Calculate cost for QC transfer movements
          const canonicalOut = await getCanonicalMovementFields(
            tenantId,
            itemId,
            -enteredQty,
            data.uom,
            client
          );
          const costDataOut = await calculateMovementCost(
            tenantId,
            itemId,
            canonicalOut.quantityDeltaCanonical,
            client
          );
          
          await createInventoryMovementLine(client, {
            tenantId,
            movementId,
            itemId,
            locationId: sourceLocationId,
            quantityDelta: canonicalOut.quantityDeltaCanonical,
            uom: canonicalOut.canonicalUom,
            quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
            uomEntered: canonicalOut.uomEntered,
            quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
            canonicalUom: canonicalOut.canonicalUom,
            uomDimension: canonicalOut.uomDimension,
            unitCost: costDataOut.unitCost,
            extendedCost: costDataOut.extendedCost,
            reasonCode: `${reasonCode}_out`,
            lineNotes: `QC ${data.eventType} transfer out`
          });

          await applyInventoryBalanceDelta(client, {
            tenantId,
            itemId,
            locationId: sourceLocationId,
            uom: canonicalOut.canonicalUom,
            deltaOnHand: canonicalOut.quantityDeltaCanonical
          });
          
          const canonicalIn = await getCanonicalMovementFields(
            tenantId,
            itemId,
            enteredQty,
            data.uom,
            client
          );
          const costDataIn = await calculateMovementCost(
            tenantId,
            itemId,
            canonicalIn.quantityDeltaCanonical,
            client
          );
          
           await createInventoryMovementLine(client, {
             tenantId,
             movementId,
             itemId,
             locationId: destLocationId,
             quantityDelta: canonicalIn.quantityDeltaCanonical,
             uom: canonicalIn.canonicalUom,
             quantityDeltaEntered: canonicalIn.quantityDeltaEntered,
             uomEntered: canonicalIn.uomEntered,
             quantityDeltaCanonical: canonicalIn.quantityDeltaCanonical,
             canonicalUom: canonicalIn.canonicalUom,
             uomDimension: canonicalIn.uomDimension,
             unitCost: costDataIn.unitCost,
             extendedCost: costDataIn.extendedCost,
             reasonCode: `${reasonCode}_in`,
             lineNotes: `QC ${data.eventType} transfer in`
           });

          await applyInventoryBalanceDelta(client, {
            tenantId,
            itemId,
            locationId: destLocationId,
            uom: canonicalIn.canonicalUom,
            deltaOnHand: canonicalIn.quantityDeltaCanonical
          });
          await client.query(
            `INSERT INTO qc_inventory_links (
                id, tenant_id, qc_event_id, inventory_movement_id, created_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), tenantId, created.id, movementId, now]
          );

          await enqueueInventoryMovementPosted(client, tenantId, movementId);
          if (validation.overrideMetadata && data.actorType) {
            await recordAuditLog(
              {
                tenantId,
                actorType: data.actorType,
                actorId: data.actorId ?? null,
                action: 'negative_override',
                entityType: 'inventory_movement',
                entityId: movementId,
                occurredAt: now,
                metadata: {
                  reason: validation.overrideMetadata.override_reason ?? null,
                  reference: validation.overrideMetadata.override_reference ?? null,
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
