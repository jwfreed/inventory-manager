import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db';
import type { PutawayInput, PutawayLineRow, PutawayRow } from './types';
import { mapPutaway } from './mappers';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { normalizeQuantityByUom } from '../../lib/uom';
import { recordAuditLog } from '../../lib/audit';
import { validateLocationCapacity } from '../stockValidation.service';
import {
  calculatePutawayAvailability,
  defaultBreakdown,
  loadQcBreakdown,
  loadPutawayTotals,
  loadReceiptLineContexts
} from '../inbound/receivingAggregations';

async function assertReceiptLinesNotVoided(tenantId: string, lineIds: string[]) {
  if (lineIds.length === 0) return;
  const { rows } = await query(
    `SELECT prl.id, por.status
       FROM purchase_order_receipt_lines prl
       JOIN purchase_order_receipts por ON por.id = prl.purchase_order_receipt_id AND por.tenant_id = prl.tenant_id
      WHERE prl.id = ANY($1::uuid[]) AND prl.tenant_id = $2`,
    [lineIds, tenantId]
  );
  for (const row of rows) {
    if (row.status === 'voided') {
      const error: any = new Error('PUTAWAY_RECEIPT_VOIDED');
      error.lineId = row.id;
      throw error;
    }
  }
}

export async function fetchPutawayById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const putawayResult = await executor<PutawayRow>('SELECT * FROM putaways WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId
  ]);
  if (putawayResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<PutawayLineRow>(
    'SELECT * FROM putaway_lines WHERE putaway_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [id, tenantId]
  );
  const receiptLineIds = linesResult.rows.map((line) => line.purchase_order_receipt_line_id);
  const contexts = await loadReceiptLineContexts(tenantId, receiptLineIds, client);
  const qcBreakdown = await loadQcBreakdown(tenantId, receiptLineIds, client);
  const totals = await loadPutawayTotals(tenantId, receiptLineIds, client);
  return mapPutaway(putawayResult.rows[0], linesResult.rows, contexts, qcBreakdown, totals);
}

export async function createPutaway(
  tenantId: string,
  data: PutawayInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const lineIds = data.lines.map((line) => line.purchaseOrderReceiptLineId);
  const uniqueLineIds = Array.from(new Set(lineIds));
  await assertReceiptLinesNotVoided(tenantId, uniqueLineIds);
  const contexts = await loadReceiptLineContexts(tenantId, uniqueLineIds);
  if (contexts.size !== uniqueLineIds.length) {
    throw new Error('PUTAWAY_LINES_NOT_FOUND');
  }
  const qcBreakdown = await loadQcBreakdown(tenantId, uniqueLineIds);
  const totals = await loadPutawayTotals(tenantId, uniqueLineIds);

  const requestedByLine = new Map<string, number>();
  const normalizedLines = data.lines.map((line, index) => {
    const context = contexts.get(line.purchaseOrderReceiptLineId)!;
    const normalized = normalizeQuantityByUom(line.quantity, line.uom);
    if (context.uom !== normalized.uom) {
      throw new Error('PUTAWAY_UOM_MISMATCH');
    }
    const fromLocationId = line.fromLocationId ?? context.defaultFromLocationId;
    if (!fromLocationId) {
      throw new Error('PUTAWAY_FROM_LOCATION_REQUIRED');
    }
    if (fromLocationId === line.toLocationId) {
      throw new Error('PUTAWAY_SAME_LOCATION');
    }
    const qty = normalized.quantity;
    requestedByLine.set(line.purchaseOrderReceiptLineId, (requestedByLine.get(line.purchaseOrderReceiptLineId) ?? 0) + qty);
    return {
      lineNumber: line.lineNumber ?? index + 1,
      receiptLineId: line.purchaseOrderReceiptLineId,
      toLocationId: line.toLocationId,
      fromLocationId,
      itemId: context.itemId,
      uom: normalized.uom,
      quantity: qty,
      notes: line.notes ?? null
    };
  });

  const lineNumbers = new Set<number>();
  for (const line of normalizedLines) {
    if (lineNumbers.has(line.lineNumber)) {
      throw new Error('PUTAWAY_DUPLICATE_LINE');
    }
    lineNumbers.add(line.lineNumber);
  }

  for (const [lineId, qty] of requestedByLine.entries()) {
    const context = contexts.get(lineId)!;
    const qc = qcBreakdown.get(lineId) ?? defaultBreakdown();
    const total = totals.get(lineId) ?? { posted: 0, pending: 0 };
    const availability = calculatePutawayAvailability(context, qc, total);
    if (availability.blockedReason && availability.availableForPlanning <= 0) {
      throw new Error('PUTAWAY_BLOCKED');
    }
    if (roundQuantity(qty) - availability.availableForPlanning > 1e-6) {
      const error: any = new Error('PUTAWAY_QUANTITY_EXCEEDED');
      error.lineId = lineId;
      throw error;
    }
  }

  // Validate location capacity
  const itemsByLocation = new Map<string, { itemId: string; quantity: number; uom: string }[]>();
  for (const line of normalizedLines) {
    const items = itemsByLocation.get(line.toLocationId) ?? [];
    items.push({ itemId: line.itemId, quantity: line.quantity, uom: line.uom });
    itemsByLocation.set(line.toLocationId, items);
  }

  for (const [locationId, items] of itemsByLocation.entries()) {
    await validateLocationCapacity(tenantId, locationId, items);
  }

  let receiptIdForPutaway = data.purchaseOrderReceiptId ?? null;
  if (!receiptIdForPutaway) {
    const uniqueReceiptIds = new Set(
      normalizedLines.map((line) => contexts.get(line.receiptLineId)?.receiptId).filter(Boolean) as string[]
    );
    if (uniqueReceiptIds.size === 1) {
      receiptIdForPutaway = Array.from(uniqueReceiptIds)[0] ?? null;
    }
  }

  if (data.sourceType === 'purchase_order_receipt' && !receiptIdForPutaway) {
    throw new Error('PUTAWAY_RECEIPT_REQUIRED');
  }

  const now = new Date();
  const putawayId = uuidv4();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO putaways (
          id, tenant_id, status, source_type, purchase_order_receipt_id, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [putawayId, tenantId, 'draft', data.sourceType, receiptIdForPutaway ?? null, data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO putaway_lines (
            id, tenant_id, putaway_id, purchase_order_receipt_line_id, line_number,
            item_id, uom, quantity_planned, from_location_id, to_location_id,
            status, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $12)`,
        [
          uuidv4(),
          tenantId,
          putawayId,
          line.receiptLineId,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.quantity,
          line.fromLocationId,
          line.toLocationId,
          line.notes,
          now
        ]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'putaway',
          entityId: putawayId,
          occurredAt: now,
          metadata: {
            sourceType: data.sourceType,
            purchaseOrderReceiptId: receiptIdForPutaway ?? null,
            lineCount: normalizedLines.length
          }
        },
        client
      );
    }
  });

  const putaway = await fetchPutawayById(tenantId, putawayId);
  if (!putaway) {
    throw new Error('PUTAWAY_NOT_FOUND_AFTER_CREATE');
  }
  return putaway;
}
