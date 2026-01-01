import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '../../db';
import type { PutawayLineRow, PutawayRow } from './types';
import { fetchPutawayById } from './core.service';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { normalizeQuantityByUom } from '../../lib/uom';
import { recordAuditLog } from '../../lib/audit';
import { validateSufficientStock } from '../stockValidation.service';
import { calculateMovementCost } from '../costing.service';
import {
  calculatePutawayAvailability,
  defaultBreakdown,
  loadQcBreakdown,
  loadPutawayTotals,
  loadReceiptLineContexts
} from '../inbound/receivingAggregations';

async function assertReceiptLinesNotVoided(tenantId: string, lineIds: string[], client: any) {
  if (lineIds.length === 0) return;
  const { rows } = await client.query(
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
    await assertReceiptLinesNotVoided(tenantId, receiptLineIds, client);
    const contexts = await loadReceiptLineContexts(tenantId, receiptLineIds, client);
    const qcBreakdown = await loadQcBreakdown(tenantId, receiptLineIds, client);
    const totals = await loadPutawayTotals(tenantId, receiptLineIds, client);

    const movementId = uuidv4();
    for (const line of pendingLines) {
      const contextData = contexts.get(line.purchase_order_receipt_line_id);
      if (!contextData) {
        throw new Error('PUTAWAY_CONTEXT_MISSING');
      }
      if (!line.quantity_planned || toNumber(line.quantity_planned) <= 0) {
        throw new Error('PUTAWAY_INVALID_QUANTITY');
      }
      const qc = qcBreakdown.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const total = totals.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
      const availability = calculatePutawayAvailability(
        contextData,
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
      const normalized = normalizeQuantityByUom(roundQuantity(toNumber(line.quantity_planned)), line.uom);
      const qty = normalized.quantity;
      const lineNote = `Putaway ${id} line ${line.line_number}`;
      
      // Calculate cost for this movement
      const costData = await calculateMovementCost(tenantId, line.item_id, -qty, client);
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'putaway', $10)`,
        [uuidv4(), tenantId, movementId, line.item_id, line.from_location_id, -qty, normalized.uom, costData.unitCost, costData.extendedCost, lineNote]
      );
      
      // Positive movement uses same unit cost, but positive extended cost
      const costDataPositive = await calculateMovementCost(tenantId, line.item_id, qty, client);
      
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, unit_cost, extended_cost, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'putaway', $10)`,
        [uuidv4(), tenantId, movementId, line.item_id, line.to_location_id, qty, normalized.uom, costDataPositive.unitCost, costDataPositive.extendedCost, lineNote]
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
