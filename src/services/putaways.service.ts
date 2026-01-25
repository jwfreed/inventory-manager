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
import { createInventoryMovement, createInventoryMovementLine } from '../domains/inventory';
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
  item_sku?: string | null;
  item_name?: string | null;
  uom: string;
  quantity_planned: string | number | null;
  quantity_moved: string | number | null;
  from_location_id: string;
  from_location_code?: string | null;
  from_location_name?: string | null;
  to_location_id: string;
  to_location_code?: string | null;
  to_location_name?: string | null;
  inventory_movement_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PutawayRow = {
  id: string;
  putaway_number?: string | null;
  status: string;
  source_type: string;
  purchase_order_receipt_id: string | null;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  completed_by_user_id?: string | null;
  completed_by_name?: string | null;
  completed_by_email?: string | null;
  receipt_number?: string | null;
  purchase_order_number?: string | null;
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

async function generatePutawayNumber() {
  const { rows } = await query(`SELECT nextval('putaway_number_seq') AS seq`);
  const seq = Number(rows[0]?.seq ?? 0);
  const padded = String(seq).padStart(6, '0');
  return `P-${padded}`;
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
    itemSku: (line as any).item_sku ?? null,
    itemName: (line as any).item_name ?? null,
    uom: line.uom,
    quantityPlanned: plannedQty,
    quantityMoved: movedQty,
    fromLocationId: line.from_location_id,
    fromLocationCode: (line as any).from_location_code ?? null,
    fromLocationName: (line as any).from_location_name ?? null,
    toLocationId: line.to_location_id,
    toLocationCode: (line as any).to_location_code ?? null,
    toLocationName: (line as any).to_location_name ?? null,
    inventoryMovementId: line.inventory_movement_id,
    status: line.status,
    notes: line.notes,
    createdAt: line.created_at,
    updatedAt: line.updated_at,
    qcBreakdown: qc,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning,
    putawayBlockedReason: availability.blockedReason ?? null
  };
}

function mapPutaway(row: PutawayRow, lines: PutawayLineRow[], contexts: Map<string, ReceiptLineContext>, qcMap: Map<string, ReturnType<typeof defaultBreakdown>>, totalsMap: Map<string, { posted: number; pending: number }>) {
  return {
    id: row.id,
    putawayNumber: row.putaway_number ?? null,
    status: row.status,
    sourceType: row.source_type,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    receiptNumber: row.receipt_number ?? null,
    purchaseOrderNumber: row.purchase_order_number ?? null,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    completedByUserId: row.completed_by_user_id ?? null,
    completedByName: row.completed_by_name ?? null,
    completedByEmail: row.completed_by_email ?? null,
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
  const putawayResult = await executor<PutawayRow>(
    `SELECT p.*,
            por.receipt_number,
            po.po_number AS purchase_order_number,
            u.full_name AS completed_by_name,
            u.email AS completed_by_email
       FROM putaways p
       LEFT JOIN purchase_order_receipts por ON por.id = p.purchase_order_receipt_id AND por.tenant_id = p.tenant_id
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
       LEFT JOIN users u ON u.id = p.completed_by_user_id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [id, tenantId]
  );
  if (putawayResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor<PutawayLineRow>(
    `SELECT pl.*,
            i.sku AS item_sku,
            i.name AS item_name,
            lf.code AS from_location_code,
            lf.name AS from_location_name,
            lt.code AS to_location_code,
            lt.name AS to_location_name
       FROM putaway_lines pl
       LEFT JOIN items i ON i.id = pl.item_id AND i.tenant_id = pl.tenant_id
       LEFT JOIN locations lf ON lf.id = pl.from_location_id AND lf.tenant_id = pl.tenant_id
       LEFT JOIN locations lt ON lt.id = pl.to_location_id AND lt.tenant_id = pl.tenant_id
      WHERE pl.putaway_id = $1 AND pl.tenant_id = $2
      ORDER BY pl.line_number ASC`,
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
  const putawayNumber = await generatePutawayNumber();

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO putaways (
          id, tenant_id, status, source_type, purchase_order_receipt_id, notes, created_at, updated_at, putaway_number
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
      [
        putawayId,
        tenantId,
        'draft',
        data.sourceType,
        receiptIdForPutaway ?? null,
        data.notes ?? null,
        now,
        putawayNumber
      ]
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
        overrideReason: context?.overrideReason ?? null,
        overrideReference: `putaway:${id}`
      }
    );

    await createInventoryMovement(client, {
      id: movementId,
      tenantId,
      movementType: 'transfer',
      status: 'posted',
      externalRef: `putaway:${id}`,
      occurredAt: now,
      postedAt: now,
      notes: `Putaway ${id}`,
      metadata: validation.overrideMetadata ?? null,
      createdAt: now,
      updatedAt: now
    });

    for (const line of pendingLines) {
      const qty = toNumber(line.quantity_planned);
      const lineNote = `Putaway ${id} line ${line.line_number}`;
      
      // Calculate cost for this movement
      const canonicalOut = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        -qty,
        line.uom,
        client
      );
      const costData = await calculateMovementCost(
        tenantId,
        line.item_id,
        canonicalOut.quantityDeltaCanonical,
        client
      );
      
      await createInventoryMovementLine(client, {
        tenantId,
        movementId,
        itemId: line.item_id,
        locationId: line.from_location_id,
        quantityDelta: canonicalOut.quantityDeltaCanonical,
        uom: canonicalOut.canonicalUom,
        quantityDeltaEntered: canonicalOut.quantityDeltaEntered,
        uomEntered: canonicalOut.uomEntered,
        quantityDeltaCanonical: canonicalOut.quantityDeltaCanonical,
        canonicalUom: canonicalOut.canonicalUom,
        uomDimension: canonicalOut.uomDimension,
        unitCost: costData.unitCost,
        extendedCost: costData.extendedCost,
        reasonCode: 'putaway',
        lineNotes: lineNote
      });
      
      // Positive movement uses same unit cost, but positive extended cost
      const canonicalIn = await getCanonicalMovementFields(
        tenantId,
        line.item_id,
        qty,
        line.uom,
        client
      );
      const costDataPositive = await calculateMovementCost(
        tenantId,
        line.item_id,
        canonicalIn.quantityDeltaCanonical,
        client
      );
      
      await createInventoryMovementLine(client, {
        tenantId,
        movementId,
        itemId: line.item_id,
        locationId: line.to_location_id,
        quantityDelta: canonicalIn.quantityDeltaCanonical,
        uom: canonicalIn.canonicalUom,
        quantityDeltaEntered: canonicalIn.quantityDeltaEntered,
        uomEntered: canonicalIn.uomEntered,
        quantityDeltaCanonical: canonicalIn.quantityDeltaCanonical,
        canonicalUom: canonicalIn.canonicalUom,
        uomDimension: canonicalIn.uomDimension,
        unitCost: costDataPositive.unitCost,
        extendedCost: costDataPositive.extendedCost,
        reasonCode: 'putaway',
        lineNotes: lineNote
      });
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
      `UPDATE putaways
          SET status = $1,
              inventory_movement_id = $2,
              updated_at = $3,
              completed_at = $3,
              completed_by_user_id = $6
        WHERE id = $4 AND tenant_id = $5`,
      ['completed', movementId, now, id, tenantId, context?.actor?.id ?? null]
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
            reference: validation.overrideMetadata.override_reference ?? null,
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
