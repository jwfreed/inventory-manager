import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import type { z } from 'zod';
import {
  calculatePutawayAvailability,
  defaultBreakdown,
  loadPutawayTotals,
  loadQcBreakdown
} from './inbound/receivingAggregations';
import type { QcBreakdown } from './inbound/receivingAggregations';
import { roundQuantity, toNumber } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';
import { query as baseQuery } from '../db';
import { updatePoStatusFromReceipts } from './status/purchaseOrdersStatus.service';

type PurchaseOrderReceiptInput = z.infer<typeof purchaseOrderReceiptSchema>;

function buildQcSummary(lineId: string, breakdownMap: Map<string, QcBreakdown>, quantityReceived: number) {
  const breakdown = breakdownMap.get(lineId) ?? defaultBreakdown();
  const totalQcQuantity = roundQuantity(breakdown.hold + breakdown.accept + breakdown.reject);
  return {
    totalQcQuantity,
    breakdown,
    remainingUninspectedQuantity: roundQuantity(Math.max(0, quantityReceived - totalQcQuantity))
  };
}

function mapReceiptLine(
  line: any,
  qcBreakdown: Map<string, QcBreakdown>,
  totalsMap: Map<string, { posted: number; pending: number }>
) {
  const quantityReceived = roundQuantity(toNumber(line.quantity_received));
  const qc = qcBreakdown.get(line.id) ?? defaultBreakdown();
  const totals = totalsMap.get(line.id) ?? { posted: 0, pending: 0 };
  const availability = calculatePutawayAvailability(
    {
      id: line.id,
      receiptId: line.purchase_order_receipt_id,
      purchaseOrderId: line.purchase_order_id ?? '',
      itemId: line.item_id ?? '',
      uom: line.uom,
      quantityReceived,
      defaultFromLocationId: line.received_to_location_id ?? line.item_default_location_id ?? null
    },
    qc,
    totals
  );
  return {
    id: line.id,
    purchaseOrderReceiptId: line.purchase_order_receipt_id,
    purchaseOrderLineId: line.purchase_order_line_id,
    defaultFromLocationId: line.received_to_location_id ?? line.item_default_location_id ?? null,
    itemId: line.item_id,
    itemSku: line.item_sku ?? null,
    itemName: line.item_name ?? null,
    defaultToLocationId: line.item_default_location_id ?? null,
    uom: line.uom,
    quantityReceived,
    createdAt: line.created_at,
    qcSummary: buildQcSummary(line.id, qcBreakdown, quantityReceived),
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning,
    putawayBlockedReason: availability.blockedReason ?? null
  };
}

function mapReceipt(
  row: any,
  lineRows: any[],
  qcBreakdown: Map<string, QcBreakdown>,
  totalsMap: Map<string, { posted: number; pending: number }>
) {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNumber: row.po_number ?? null,
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    lines: lineRows.map((line) => mapReceiptLine(line, qcBreakdown, totalsMap))
  };
}

export async function fetchReceiptById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ?? query;
  const receiptResult = await executor(
    `SELECT por.*, po.po_number
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
      WHERE por.id = $1 AND por.tenant_id = $2`,
    [id, tenantId]
  );
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor(
    `SELECT porl.*,
            pol.item_id,
            pol.purchase_order_id,
            i.sku AS item_sku,
            i.name AS item_name,
            i.default_location_id AS item_default_location_id,
            por.received_to_location_id
       FROM purchase_order_receipt_lines porl
       JOIN purchase_order_receipts por ON por.id = porl.purchase_order_receipt_id AND por.tenant_id = porl.tenant_id
       LEFT JOIN purchase_order_lines pol ON pol.id = porl.purchase_order_line_id AND pol.tenant_id = porl.tenant_id
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = porl.tenant_id
      WHERE porl.purchase_order_receipt_id = $1 AND porl.tenant_id = $2
      ORDER BY porl.created_at ASC`,
    [id, tenantId]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(tenantId, lineIds, client);
  const totals = await loadPutawayTotals(tenantId, lineIds, client);
  return mapReceipt(receiptResult.rows[0], linesResult.rows, breakdown, totals);
}

export async function createPurchaseOrderReceipt(tenantId: string, data: PurchaseOrderReceiptInput) {
  const receiptId = uuidv4();
  const uniqueSet = new Set(data.lines.map((line) => line.purchaseOrderLineId));
  const uniqueLineIds = Array.from(uniqueSet);

  const poResult = await query(
    'SELECT status, ship_to_location_id, receiving_location_id FROM purchase_orders WHERE id = $1 AND tenant_id = $2',
    [data.purchaseOrderId, tenantId]
  );
  if (poResult.rowCount === 0) {
    throw new Error('RECEIPT_PO_NOT_FOUND');
  }
  const poRow = poResult.rows[0];
  if (['received', 'closed'].includes(poRow.status)) {
    throw new Error('RECEIPT_PO_ALREADY_RECEIVED');
  }

  const { rows: poLineRows } = await query(
    'SELECT id, purchase_order_id, uom FROM purchase_order_lines WHERE id = ANY($1::uuid[]) AND tenant_id = $2',
    [uniqueLineIds, tenantId]
  );
  if (poLineRows.length !== uniqueLineIds.length) {
    throw new Error('RECEIPT_PO_LINES_NOT_FOUND');
  }
  const poLineMap = new Map<string, { purchase_order_id: string; uom: string }>();
  for (const row of poLineRows) {
    poLineMap.set(row.id, { purchase_order_id: row.purchase_order_id, uom: row.uom });
  }
  for (const line of data.lines) {
    const poLine = poLineMap.get(line.purchaseOrderLineId);
    if (!poLine) {
      throw new Error('RECEIPT_LINE_INVALID_REFERENCE');
    }
    if (poLine.purchase_order_id !== data.purchaseOrderId) {
      throw new Error('RECEIPT_LINES_WRONG_PO');
    }
    if (poLine.uom !== line.uom) {
      throw new Error('RECEIPT_LINE_UOM_MISMATCH');
    }
  }

  // Default receiving location: prefer explicit provided, otherwise PO receiving/staging, otherwise dedicated receiving, otherwise ship-to.
  let resolvedReceivedToLocationId = data.receivedToLocationId ?? null;
  if (!resolvedReceivedToLocationId) {
    const receivingLoc = poRow.receiving_location_id ?? (await findDefaultReceivingLocation(tenantId));
    resolvedReceivedToLocationId = receivingLoc ?? poRow.ship_to_location_id ?? null;
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO purchase_order_receipts (
          id, tenant_id, purchase_order_id, received_at, received_to_location_id,
          inventory_movement_id, external_ref, notes
       ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
      [
        receiptId,
        tenantId,
        data.purchaseOrderId,
        new Date(data.receivedAt),
        resolvedReceivedToLocationId,
        data.externalRef ?? null,
        data.notes ?? null
      ]
    );

    for (const line of data.lines) {
      const normalized = normalizeQuantityByUom(line.quantityReceived, line.uom);
      await client.query(
        `INSERT INTO purchase_order_receipt_lines (
            id, tenant_id, purchase_order_receipt_id, purchase_order_line_id, uom, quantity_received
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), tenantId, receiptId, line.purchaseOrderLineId, normalized.uom, normalized.quantity]
      );
    }
  });

  const receipt = await fetchReceiptById(tenantId, receiptId);
  if (!receipt) {
    throw new Error('RECEIPT_NOT_FOUND_AFTER_CREATE');
  }
  await updatePoStatusFromReceipts(tenantId, receipt.purchaseOrderId);
  return receipt;
}

export async function listReceipts(tenantId: string, limit = 20, offset = 0) {
  const { rows } = await query(
    `SELECT por.id,
            por.purchase_order_id AS "purchaseOrderId",
            po.po_number AS "purchaseOrderNumber",
            por.received_at AS "receivedAt",
            por.received_to_location_id AS "receivedToLocationId",
            por.inventory_movement_id AS "inventoryMovementId",
            por.external_ref AS "externalRef",
            por.notes,
            por.created_at AS "createdAt",
            EXISTS (
              SELECT 1
                FROM purchase_order_receipt_lines porl
                JOIN putaway_lines pl
                  ON pl.purchase_order_receipt_line_id = porl.id
                 AND pl.tenant_id = porl.tenant_id
               WHERE porl.purchase_order_receipt_id = por.id
                 AND porl.tenant_id = por.tenant_id
            ) AS "hasPutaway"
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
      WHERE por.tenant_id = $1
       ORDER BY por.created_at DESC
       LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows;
}

export async function deleteReceipt(tenantId: string, id: string) {
  const { rows: receiptLineIds } = await query(
    'SELECT id FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  const lineIds = receiptLineIds.map((r) => r.id);
  if (lineIds.length > 0) {
    const { rows: putawayRefs } = await query(
      `SELECT pl.id,
              pl.putaway_id,
              pl.status AS line_status,
              p.status AS putaway_status,
              pl.inventory_movement_id
         FROM putaway_lines pl
         JOIN putaways p ON p.id = pl.putaway_id AND p.tenant_id = pl.tenant_id
        WHERE pl.purchase_order_receipt_line_id = ANY($1::uuid[]) AND pl.tenant_id = $2`,
      [lineIds, tenantId]
    );
    if (putawayRefs.length > 0) {
      const hasPosted = putawayRefs.some(
        (r) => r.line_status === 'completed' || r.putaway_status === 'completed' || r.inventory_movement_id
      );
      if (hasPosted) {
        throw new Error('RECEIPT_HAS_PUTAWAYS_POSTED');
      }
      // Safe to delete pending putaways tied to this receipt
      const putawayIds = Array.from(new Set(putawayRefs.map((r) => r.putaway_id)));
      await withTransaction(async (client) => {
        await client.query('DELETE FROM putaway_lines WHERE putaway_id = ANY($1::uuid[]) AND tenant_id = $2', [
          putawayIds,
          tenantId
        ]);
        await client.query('DELETE FROM putaways WHERE id = ANY($1::uuid[]) AND tenant_id = $2', [putawayIds, tenantId]);
      });
    }
  }
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    await client.query('DELETE FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  });
}
async function findDefaultReceivingLocation(tenantId: string): Promise<string | null> {
  const { rows } = await baseQuery(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND active = true
        AND (type = 'receiving' OR code ILIKE '%recv%' OR name ILIKE '%receiv%')
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId]
  );
  return rows[0]?.id ?? null;
}
