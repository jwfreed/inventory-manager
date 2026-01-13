import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { putawaySchema } from '../schemas/putaways.schema';
import type { z } from 'zod';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock, validateLocationCapacity } from './stockValidation.service';
import { calculateMovementCost } from './costing.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import {
  calculateAcceptedQuantity,
  calculatePutawayAvailability,
  defaultBreakdown,
  loadQcBreakdown,
  loadPutawayTotals,
  loadReceiptLineContexts,
  type ReceiptLineContext
} from './inbound/receivingAggregations';

type PutawayInput = z.infer<typeof putawaySchema>;

type PutawayLineRow = {
  id: string;
  putaway_id: string;
  purchase_order_receipt_line_id: string;
  line_number: number;
  item_id: string;
  uom: string;
  quantity_planned: string | number | null;
  quantity_moved: string | number | null;
  from_location_id: string;
  to_location_id: string;
  inventory_movement_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PutawayRow = {
  id: string;
  status: string;
  source_type: string;
  purchase_order_receipt_id: string | null;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

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

function mapPutawayLine(
  line: PutawayLineRow,
  context: ReceiptLineContext,
  qc: ReturnType<typeof defaultBreakdown>,
  totals: { posted: number; pending: number }
) {
  const plannedQty = roundQuantity(toNumber(line.quantity_planned ?? line.quantity_moved ?? 0));
  const movedQty = line.quantity_moved ? roundQuantity(toNumber(line.quantity_moved)) : null;
  const availability = calculatePutawayAvailability(context, qc, totals);
  return {
    id: line.id,
    lineNumber: line.line_number,
    purchaseOrderReceiptLineId: line.purchase_order_receipt_line_id,
    itemId: line.item_id,
    uom: line.uom,
    quantityPlanned: plannedQty,
    quantityMoved: movedQty,
    fromLocationId: line.from_location_id,
    toLocationId: line.to_location_id,
    inventoryMovementId: line.inventory_movement_id,
    status: line.status,
    notes: line.notes,
    createdAt: line.created_at,
    updatedAt: line.updated_at,
    qcBreakdown: qc,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning
  };
}

function mapPutaway(row: PutawayRow, lines: PutawayLineRow[], contexts: Map<string, ReceiptLineContext>, qcMap: Map<string, ReturnType<typeof defaultBreakdown>>, totalsMap: Map<string, { posted: number; pending: number }>) {
  return {
    id: row.id,
    status: row.status,
    sourceType: row.source_type,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => {
      const context = contexts.get(line.purchase_order_receipt_line_id);
      const qc = qcMap.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const totals = totalsMap.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
      if (!context) {
        throw new Error('Missing receipt line context for putaway line');
      }
      return mapPutawayLine(line, context, qc, totals);
    })
  };
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
    if (context.uom !== line.uom) {
      throw new Error('PUTAWAY_UOM_MISMATCH');
    }
    const fromLocationId = line.fromLocationId ?? context.defaultFromLocationId;
    if (!fromLocationId) {
      throw new Error('PUTAWAY_FROM_LOCATION_REQUIRED');
    }
    if (fromLocationId === line.toLocationId) {
      throw new Error('PUTAWAY_SAME_LOCATION');
    }
    const qty = toNumber(line.quantity);
    requestedByLine.set(line.purchaseOrderReceiptLineId, (requestedByLine.get(line.purchaseOrderReceiptLineId) ?? 0) + qty);
    return {
      lineNumber: line.lineNumber ?? index + 1,
      receiptLineId: line.purchaseOrderReceiptLineId,
      toLocationId: line.toLocationId,
      fromLocationId,
      itemId: context.itemId,
      uom: line.uom,
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

export async function postPutaway(
  tenantId: string,
  id: string,
  context?: {
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  return withTransaction(async (client) => {
    const now = new Date();
    const putawayResult = await client.query<PutawayRow>(
      'SELECT * FROM putaways WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (putawayResult.rowCount === 0) {
      throw new Error('PUTAWAY_NOT_FOUND');
    }
    const putaway = putawayResult.rows[0];
    if (putaway.status === 'completed') {
      throw new Error('PUTAWAY_ALREADY_POSTED');
    }
    if (putaway.status === 'canceled') {
      throw new Error('PUTAWAY_CANCELED');
    }

    const linesResult = await client.query<PutawayLineRow>(
      'SELECT * FROM putaway_lines WHERE putaway_id = $1 AND tenant_id = $2 ORDER BY line_number ASC FOR UPDATE',
      [id, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('PUTAWAY_NO_LINES');
    }
    const pendingLines = linesResult.rows.filter((line) => line.status === 'pending');
    if (pendingLines.length === 0) {
      throw new Error('PUTAWAY_NOTHING_TO_POST');
    }

    const receiptLineIds = pendingLines.map((line) => line.purchase_order_receipt_line_id);
    await assertReceiptLinesNotVoided(tenantId, receiptLineIds);
    const contexts = await loadReceiptLineContexts(tenantId, receiptLineIds);
    const qcBreakdown = await loadQcBreakdown(tenantId, receiptLineIds);
    const totals = await loadPutawayTotals(tenantId, receiptLineIds);

    const movementId = uuidv4();
    for (const line of pendingLines) {
      const context = contexts.get(line.purchase_order_receipt_line_id);
      if (!context) {
        throw new Error('PUTAWAY_CONTEXT_MISSING');
      }
      if (!line.quantity_planned || toNumber(line.quantity_planned) <= 0) {
        throw new Error('PUTAWAY_INVALID_QUANTITY');
      }
      const qc = qcBreakdown.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const total = totals.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
      const availability = calculatePutawayAvailability(
        context,
        qc,
        total,
        roundQuantity(toNumber(line.quantity_planned))
      );
      if (availability.blockedReason && availability.availableForPlanning <= 0) {
        throw new Error('PUTAWAY_QC_BLOCKED');
      }
      if (roundQuantity(toNumber(line.quantity_planned)) - availability.availableForPlanning > 1e-6) {
        throw new Error('PUTAWAY_QUANTITY_EXCEEDED');
      }
      if (roundQuantity(toNumber(line.quantity_planned)) - availability.remainingAfterPosted > 1e-6) {
        throw new Error('PUTAWAY_ACCEPT_LIMIT');
      }
    }

    const validation = await validateSufficientStock(
      tenantId,
      now,
      pendingLines.map((line) => ({
        itemId: line.item_id,
        locationId: line.from_location_id,
        uom: line.uom,
        quantityToConsume: roundQuantity(toNumber(line.quantity_planned ?? 0))
      })),
      {
        actorId: context?.actor?.id ?? null,
        actorRole: context?.actor?.role ?? null,
        overrideRequested: context?.overrideRequested,
        overrideReason: context?.overrideReason ?? null
      }
    );

    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'transfer', 'posted', $3, $4, $4, $5, $6, $4, $4)`,
      [movementId, tenantId, `putaway:${id}`, now, `Putaway ${id}`, validation.overrideMetadata ?? null]
    );

    for (const line of pendingLines) {
      const qty = toNumber(line.quantity_planned);
      const lineNote = `Putaway ${id} line ${line.line_number}`;
      
      // Calculate cost for this movement
      const costData = await calculateMovementCost(tenantId, line.item_id, -qty, client);
      const canonicalOut = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        -qty,
        line.uom,
        client
      );
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'putaway', $15)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.item_id,
          line.from_location_id,
          -qty,
          line.uom,
          canonicalOut.quantityDeltaEntered,
          canonicalOut.uomEntered,
          canonicalOut.quantityDeltaCanonical,
          canonicalOut.canonicalUom,
          canonicalOut.uomDimension,
          costData.unitCost,
          costData.extendedCost,
          lineNote
        ]
      );
      
      // Positive movement uses same unit cost, but positive extended cost
      const costDataPositive = await calculateMovementCost(tenantId, line.item_id, qty, client);
      const canonicalIn = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        qty,
        line.uom,
        client
      );
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom,
            quantity_delta_entered, uom_entered, quantity_delta_canonical, canonical_uom, uom_dimension,
            unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'putaway', $15)`,
        [
          uuidv4(),
          tenantId,
          movementId,
          line.item_id,
          line.to_location_id,
          qty,
          line.uom,
          canonicalIn.quantityDeltaEntered,
          canonicalIn.uomEntered,
          canonicalIn.quantityDeltaCanonical,
          canonicalIn.canonicalUom,
          canonicalIn.uomDimension,
          costDataPositive.unitCost,
          costDataPositive.extendedCost,
          lineNote
        ]
      );
      await client.query(
        `UPDATE putaway_lines
            SET status = 'completed',
                quantity_moved = $1,
                inventory_movement_id = $2,
                updated_at = $3
         WHERE id = $4 AND tenant_id = $5`,
        [qty, movementId, now, line.id, tenantId]
      );
    }

    await client.query(
      'UPDATE putaways SET status = $1, inventory_movement_id = $2, updated_at = $3 WHERE id = $4 AND tenant_id = $5',
      ['completed', movementId, now, id, tenantId]
    );

    if (context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'post',
          entityType: 'putaway',
          entityId: id,
          occurredAt: now,
          metadata: { movementId }
        },
        client
      );
    }

    if (validation.overrideMetadata && context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movementId,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            putawayId: id,
            lines: pendingLines.map((line) => ({
              itemId: line.item_id,
              locationId: line.from_location_id,
              uom: line.uom,
              quantity: roundQuantity(toNumber(line.quantity_planned ?? 0))
            }))
          }
        },
        client
      );
    }

    return fetchPutawayById(tenantId, id, client);
  });
}
