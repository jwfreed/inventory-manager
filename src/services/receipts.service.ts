import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import type { z } from 'zod';
import {
  calculatePutawayAvailability,
  calculateAcceptedQuantity,
  defaultBreakdown,
  loadPutawayTotals,
  loadQcBreakdown
} from './inbound/receivingAggregations';
import type { QcBreakdown } from './inbound/receivingAggregations';
import { roundQuantity, toNumber } from '../lib/numbers';
import { query as baseQuery } from '../db';
import { updatePoStatusFromReceipts } from './status/purchaseOrdersStatus.service';
import { recordAuditLog } from '../lib/audit';
import { updateMovingAverageCost } from './costing.service';
import { createCostLayer } from './costLayers.service';

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
  const acceptedQuantity = calculateAcceptedQuantity(quantityReceived, qc, false);
  const postedQuantity = roundQuantity(totals.posted ?? 0);
  let putawayStatus = 'not_available';
  if (acceptedQuantity > 0) {
    if (postedQuantity <= 0) {
      putawayStatus = 'not_started';
    } else if (postedQuantity + 1e-6 < acceptedQuantity) {
      putawayStatus = 'partial';
    } else {
      putawayStatus = 'complete';
    }
  }
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
    expectedQuantity: roundQuantity(toNumber(line.expected_quantity ?? 0)),
    quantityReceived,
    unitCost: line.unit_cost != null ? Number(line.unit_cost) : null,
    discrepancyReason: line.discrepancy_reason ?? null,
    discrepancyNotes: line.discrepancy_notes ?? null,
    lotCode: line.lot_code ?? null,
    serialNumbers: line.serial_numbers ?? null,
    overReceiptApproved: line.over_receipt_approved ?? false,
    requiresLot: line.requires_lot ?? false,
    requiresSerial: line.requires_serial ?? false,
    requiresQc: line.requires_qc ?? false,
    createdAt: line.created_at,
    qcSummary: buildQcSummary(line.id, qcBreakdown, quantityReceived),
    putawayAcceptedQuantity: roundQuantity(acceptedQuantity),
    putawayPostedQuantity: postedQuantity,
    putawayStatus,
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
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    vendorCode: row.vendor_code ?? null,
    status: row.status ?? 'posted',
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    receivedToLocationName: row.received_to_location_name ?? null,
    receivedToLocationCode: row.received_to_location_code ?? null,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    hasPutaway: row.has_putaway ?? null,
    draftPutawayId: row.draft_putaway_id ?? null,
    lines: lineRows.map((line) => mapReceiptLine(line, qcBreakdown, totalsMap))
  };
}

const STATUS_EPSILON = 1e-6;

type ReceiptTotals = {
  totalReceived: number;
  totalAccept: number;
  totalHold: number;
  totalReject: number;
  totalAcceptedQty: number;
  putawayPosted: number;
  putawayPending: number;
};

type ReceiptStatusSummary = {
  workflowStatus: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  putawayStatus: 'not_available' | 'not_started' | 'pending' | 'complete';
  qcEligible: boolean;
  putawayEligible: boolean;
};

function buildReceiptStatusSummary(baseStatus: string | null | undefined, totals: ReceiptTotals): ReceiptStatusSummary {
  const totalReceived = roundQuantity(totals.totalReceived);
  const totalAccept = roundQuantity(totals.totalAccept);
  const totalHold = roundQuantity(totals.totalHold);
  const totalReject = roundQuantity(totals.totalReject);
  const totalAcceptedQty = roundQuantity(totals.totalAcceptedQty);
  const putawayPosted = roundQuantity(totals.putawayPosted);
  const putawayPending = roundQuantity(totals.putawayPending);

  const remainingQc = Math.max(0, totalReceived - (totalAccept + totalHold + totalReject));
  const hasReceived = totalReceived > STATUS_EPSILON;

  let qcStatus: ReceiptStatusSummary['qcStatus'];
  if (baseStatus === 'voided') {
    qcStatus = 'failed';
  } else if (!hasReceived) {
    qcStatus = 'pending';
  } else if (remainingQc > STATUS_EPSILON) {
    qcStatus = 'pending';
  } else if (totalHold > STATUS_EPSILON) {
    qcStatus = 'failed';
  } else if (totalAccept > STATUS_EPSILON) {
    qcStatus = 'passed';
  } else {
    qcStatus = 'failed';
  }

  let putawayStatus: ReceiptStatusSummary['putawayStatus'] = 'not_available';
  if (qcStatus === 'passed' && totalAcceptedQty > STATUS_EPSILON) {
    const totalPutaway = putawayPosted + putawayPending;
    if (totalPutaway <= STATUS_EPSILON) {
      putawayStatus = 'not_started';
    } else if (putawayPosted + STATUS_EPSILON >= totalAcceptedQty) {
      putawayStatus = 'complete';
    } else {
      putawayStatus = 'pending';
    }
  }

  let workflowStatus = 'posted';
  if (baseStatus === 'voided') {
    workflowStatus = 'voided';
  } else if (baseStatus === 'draft') {
    workflowStatus = 'draft';
  } else if (!hasReceived) {
    workflowStatus = 'posted';
  } else if (qcStatus === 'pending') {
    workflowStatus = 'pending_qc';
  } else if (qcStatus === 'failed') {
    workflowStatus = 'qc_failed';
  } else if (putawayStatus === 'complete') {
    workflowStatus = 'complete';
  } else if (putawayStatus === 'pending') {
    workflowStatus = 'putaway_pending';
  } else {
    workflowStatus = 'qc_passed';
  }

  const qcEligible = baseStatus === 'posted' && remainingQc > STATUS_EPSILON;
  const putawayEligible =
    baseStatus === 'posted' &&
    qcStatus === 'passed' &&
    totalAcceptedQty > STATUS_EPSILON &&
    putawayPosted + putawayPending + STATUS_EPSILON < totalAcceptedQty;

  return { workflowStatus, qcStatus, putawayStatus, qcEligible, putawayEligible };
}

export async function fetchReceiptById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ? client.query.bind(client) : query;
  const receiptResult = await executor(
    `SELECT por.*,
            po.po_number,
            po.vendor_id,
            v.name AS vendor_name,
            v.code AS vendor_code,
            loc.name AS received_to_location_name,
            loc.code AS received_to_location_code,
            EXISTS (
              SELECT 1
                FROM purchase_order_receipt_lines porl
                JOIN putaway_lines pl
                  ON pl.purchase_order_receipt_line_id = porl.id
                 AND pl.tenant_id = porl.tenant_id
               WHERE porl.purchase_order_receipt_id = por.id
                 AND porl.tenant_id = por.tenant_id
            ) AS has_putaway,
            (
              SELECT p.id
                FROM putaways p
               WHERE p.purchase_order_receipt_id = por.id
                 AND p.tenant_id = por.tenant_id
                 AND p.status IN ('draft','in_progress')
               ORDER BY p.created_at DESC
               LIMIT 1
            ) AS draft_putaway_id
       FROM purchase_order_receipts por
       LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = por.tenant_id
       LEFT JOIN locations loc ON loc.id = por.received_to_location_id AND loc.tenant_id = por.tenant_id
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
            i.requires_lot,
            i.requires_serial,
            i.requires_qc,
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
  const receipt = mapReceipt(receiptResult.rows[0], linesResult.rows, breakdown, totals);

  const totalsSummary: ReceiptTotals = {
    totalReceived: 0,
    totalAccept: 0,
    totalHold: 0,
    totalReject: 0,
    totalAcceptedQty: 0,
    putawayPosted: 0,
    putawayPending: 0
  };
  for (const line of linesResult.rows) {
    const quantityReceived = roundQuantity(toNumber(line.quantity_received));
    const qc = breakdown.get(line.id) ?? defaultBreakdown();
    const lineTotals = totals.get(line.id) ?? { posted: 0, pending: 0 };
    totalsSummary.totalReceived += quantityReceived;
    totalsSummary.totalAccept += roundQuantity(qc.accept ?? 0);
    totalsSummary.totalHold += roundQuantity(qc.hold ?? 0);
    totalsSummary.totalReject += roundQuantity(qc.reject ?? 0);
    totalsSummary.totalAcceptedQty += roundQuantity(qc.accept ?? 0);
    totalsSummary.putawayPosted += roundQuantity(lineTotals.posted ?? 0);
    totalsSummary.putawayPending += roundQuantity(lineTotals.pending ?? 0);
  }

  const statusSummary = buildReceiptStatusSummary(receipt.status, totalsSummary);
  return { ...receipt, ...statusSummary };
}

export async function createPurchaseOrderReceipt(
  tenantId: string,
  data: PurchaseOrderReceiptInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const receiptId = uuidv4();
  const uniqueSet = new Set(data.lines.map((line) => line.purchaseOrderLineId));
  const uniqueLineIds = Array.from(uniqueSet);

  if (data.idempotencyKey) {
    const existing = await query(
      `SELECT id FROM purchase_order_receipts WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, data.idempotencyKey]
    );
    if (existing.rowCount && existing.rows[0]?.id) {
      const receipt = await fetchReceiptById(tenantId, existing.rows[0].id);
      if (receipt) return receipt;
    }
  }

  const poResult = await query(
    'SELECT status, ship_to_location_id, receiving_location_id FROM purchase_orders WHERE id = $1 AND tenant_id = $2',
    [data.purchaseOrderId, tenantId]
  );
  if (poResult.rowCount === 0) {
    throw new Error('RECEIPT_PO_NOT_FOUND');
  }
  const poRow = poResult.rows[0];
  if (['received', 'closed', 'canceled'].includes(poRow.status)) {
    throw new Error('RECEIPT_PO_ALREADY_RECEIVED');
  }
  if (poRow.status === 'draft') {
    throw new Error('RECEIPT_PO_NOT_APPROVED');
  }
  if (poRow.status === 'submitted') {
    if (process.env.NODE_ENV !== 'production') {
      await query(
        `UPDATE purchase_orders
            SET status = 'approved',
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [data.purchaseOrderId, tenantId]
      );
    } else {
      throw new Error('RECEIPT_PO_NOT_APPROVED');
    }
  }

  const { rows: poLineRows } = await query(
    `SELECT pol.id, pol.purchase_order_id, pol.item_id, pol.uom, pol.quantity_ordered, pol.unit_price,
            pol.over_receipt_tolerance_pct,
            i.requires_lot, i.requires_serial, i.requires_qc
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
      WHERE pol.id = ANY($1::uuid[]) AND pol.tenant_id = $2`,
    [uniqueLineIds, tenantId]
  );
  if (poLineRows.length !== uniqueLineIds.length) {
    throw new Error('RECEIPT_PO_LINES_NOT_FOUND');
  }
  const poLineMap = new Map<
    string,
    {
      purchase_order_id: string;
      item_id: string;
      uom: string;
      quantity_ordered: number;
      unit_price: number | null;
      over_receipt_tolerance_pct: number;
      requires_lot: boolean;
      requires_serial: boolean;
      requires_qc: boolean;
    }
  >();
  for (const row of poLineRows) {
    poLineMap.set(row.id, {
      purchase_order_id: row.purchase_order_id,
      item_id: row.item_id,
      uom: row.uom,
      quantity_ordered: roundQuantity(toNumber(row.quantity_ordered ?? 0)),
      unit_price: row.unit_price != null ? Number(row.unit_price) : null,
      over_receipt_tolerance_pct: row.over_receipt_tolerance_pct != null ? Number(row.over_receipt_tolerance_pct) : 0,
      requires_lot: !!row.requires_lot,
      requires_serial: !!row.requires_serial,
      requires_qc: !!row.requires_qc
    });
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
    const receivedQty = toNumber(line.quantityReceived);
    const expectedQty = roundQuantity(toNumber(poLine.quantity_ordered ?? 0));
    if (poLine.requires_lot && !line.lotCode) {
      throw new Error('RECEIPT_LOT_REQUIRED');
    }
    if (poLine.requires_serial) {
      if (!line.serialNumbers || line.serialNumbers.length === 0) {
        throw new Error('RECEIPT_SERIAL_REQUIRED');
      }
      if (!Number.isInteger(receivedQty)) {
        throw new Error('RECEIPT_SERIAL_QTY_MUST_BE_INTEGER');
      }
      const uniqueSerials = new Set(line.serialNumbers);
      if (uniqueSerials.size !== line.serialNumbers.length) {
        throw new Error('RECEIPT_SERIAL_DUPLICATE');
      }
      if (line.serialNumbers.length !== receivedQty) {
        throw new Error('RECEIPT_SERIAL_COUNT_MISMATCH');
      }
    }
    if (receivedQty - expectedQty > STATUS_EPSILON) {
      const tolerance = poLine.over_receipt_tolerance_pct ?? 0;
      const allowed = roundQuantity(expectedQty * (1 + tolerance));
      if (receivedQty - allowed > STATUS_EPSILON && !line.overReceiptApproved) {
        throw new Error('RECEIPT_OVER_RECEIPT_NOT_APPROVED');
      }
    }
  }

  // Default receiving location: prefer explicit provided, otherwise PO receiving/staging, otherwise dedicated receiving, otherwise ship-to.
  let resolvedReceivedToLocationId = data.receivedToLocationId ?? null;
  if (!resolvedReceivedToLocationId) {
    const receivingLoc = poRow.receiving_location_id ?? (await findDefaultReceivingLocation(tenantId));
    resolvedReceivedToLocationId = receivingLoc ?? poRow.ship_to_location_id ?? null;
  }

  const now = new Date();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO purchase_order_receipts (
          id, tenant_id, purchase_order_id, status, received_at, received_to_location_id,
          inventory_movement_id, external_ref, notes, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9)`,
      [
        receiptId,
        tenantId,
        data.purchaseOrderId,
        'posted',
        new Date(data.receivedAt),
        resolvedReceivedToLocationId,
        data.externalRef ?? null,
        data.notes ?? null,
        data.idempotencyKey ?? null
      ]
    );

    for (const line of data.lines) {
      const receivedQty = toNumber(line.quantityReceived);
      const expectedQty = roundQuantity(toNumber(poLineMap.get(line.purchaseOrderLineId)?.quantity_ordered ?? 0));
      const hasDiscrepancy = Math.abs(roundQuantity(receivedQty) - expectedQty) > 1e-6;
      if (hasDiscrepancy && !line.discrepancyReason) {
        throw new Error('RECEIPT_DISCREPANCY_REASON_REQUIRED');
      }

      // Default unit_cost to PO line's unit_price if not explicitly provided
      const poLine = poLineMap.get(line.purchaseOrderLineId);
      const unitCost = line.unitCost !== undefined ? line.unitCost : (poLine?.unit_price ?? null);

      await client.query(
        `INSERT INTO purchase_order_receipt_lines (
            id, tenant_id, purchase_order_receipt_id, purchase_order_line_id, uom,
            quantity_received, expected_quantity, unit_cost, discrepancy_reason, discrepancy_notes,
            lot_code, serial_numbers, over_receipt_approved
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          uuidv4(),
          tenantId,
          receiptId,
          line.purchaseOrderLineId,
          line.uom,
          receivedQty,
          expectedQty,
          unitCost,
          line.discrepancyReason ?? null,
          line.discrepancyNotes ?? null,
          line.lotCode ?? null,
          line.serialNumbers ?? null,
          line.overReceiptApproved ?? false
        ]
      );

      // Update moving average cost if unit cost is available
      if (unitCost !== null && unitCost > 0 && poLine?.item_id) {
        await updateMovingAverageCost(
          tenantId,
          poLine.item_id,
          receivedQty,
          unitCost,
          client
        );
        
        // Create cost layer for FIFO tracking
        if (resolvedReceivedToLocationId) {
          try {
            await createCostLayer({
              tenant_id: tenantId,
              item_id: poLine.item_id,
              location_id: resolvedReceivedToLocationId,
              uom: normalized.uom,
              quantity: normalized.quantity,
              unit_cost: unitCost,
              source_type: 'receipt',
              source_document_id: line.purchaseOrderLineId,
              layer_date: new Date(data.receivedAt),
              notes: `Receipt from PO line ${line.purchaseOrderLineId}`
            });
          } catch (err) {
            // Log but don't fail transaction if cost layer creation fails
            console.warn('Failed to create cost layer for receipt:', err);
          }
        }
      }
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'purchase_order_receipt',
          entityId: receiptId,
          occurredAt: now,
          metadata: {
            purchaseOrderId: data.purchaseOrderId,
            status: 'posted',
            lineCount: data.lines.length
          }
        },
        client
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

export async function fetchReceiptByIdempotencyKey(tenantId: string, key: string) {
  const existing = await query(
    'SELECT id FROM purchase_order_receipts WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, key]
  );
  if (!existing.rowCount || !existing.rows[0]?.id) return null;
  return fetchReceiptById(tenantId, existing.rows[0].id);
}

export async function listReceipts(
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
    vendorId?: string;
    from?: string;
    to?: string;
    search?: string;
    includeLines?: boolean;
  } = {}
) {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const params: Array<string | number> = [tenantId];
  const where: string[] = ['por.tenant_id = $1'];
  let paramIndex = params.length + 1;

  if (options.vendorId) {
    where.push(`po.vendor_id = $${paramIndex}`);
    params.push(options.vendorId);
    paramIndex += 1;
  }
  if (options.from) {
    where.push(`por.received_at >= $${paramIndex}`);
    params.push(options.from);
    paramIndex += 1;
  }
  if (options.to) {
    where.push(`por.received_at <= $${paramIndex}`);
    params.push(options.to);
    paramIndex += 1;
  }
  if (options.search) {
    where.push(
      `(por.id::text ILIKE $${paramIndex} OR po.po_number ILIKE $${paramIndex} OR por.external_ref ILIKE $${paramIndex})`
    );
    params.push(`%${options.search}%`);
    paramIndex += 1;
  }

  const statusFilter = options.status;
  const statusClause = statusFilter ? `WHERE receipt_status."workflowStatus" = $${paramIndex}` : '';
  if (statusFilter) {
    params.push(statusFilter);
    paramIndex += 1;
  }

  params.push(limit);
  params.push(offset);

  const { rows } = await query(
    `
    WITH line_qc AS (
      SELECT
        prl.id AS line_id,
        prl.purchase_order_receipt_id AS receipt_id,
        prl.quantity_received,
        COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0) AS accept_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0) AS hold_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0) AS reject_qty
      FROM purchase_order_receipt_lines prl
      LEFT JOIN qc_events qe
        ON qe.purchase_order_receipt_line_id = prl.id
       AND qe.tenant_id = prl.tenant_id
      WHERE prl.tenant_id = $1
      GROUP BY prl.id
    ),
    line_putaway AS (
      SELECT
        purchase_order_receipt_line_id AS line_id,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(quantity_moved, 0) ELSE 0 END) AS posted_qty,
        SUM(CASE WHEN status = 'pending' THEN COALESCE(quantity_planned, 0) ELSE 0 END) AS pending_qty
      FROM putaway_lines
      WHERE tenant_id = $1
        AND status <> 'canceled'
      GROUP BY purchase_order_receipt_line_id
    ),
    receipt_totals AS (
      SELECT
        l.receipt_id,
        COUNT(*) AS line_count,
        SUM(l.quantity_received) AS total_received,
        SUM(l.accept_qty) AS total_accept,
        SUM(l.hold_qty) AS total_hold,
        SUM(l.reject_qty) AS total_reject,
        SUM(l.accept_qty) AS total_accepted_qty,
        SUM(COALESCE(p.posted_qty, 0)) AS putaway_posted,
        SUM(COALESCE(p.pending_qty, 0)) AS putaway_pending
      FROM line_qc l
      LEFT JOIN line_putaway p ON p.line_id = l.line_id
      GROUP BY l.receipt_id
    ),
    receipt_status AS (
      SELECT
        por.id,
        por.purchase_order_id AS "purchaseOrderId",
        po.po_number AS "purchaseOrderNumber",
        po.vendor_id AS "vendorId",
        v.name AS "vendorName",
        v.code AS "vendorCode",
        por.status AS "status",
        por.received_at AS "receivedAt",
        por.received_to_location_id AS "receivedToLocationId",
        loc.name AS "receivedToLocationName",
        loc.code AS "receivedToLocationCode",
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
        ) AS "hasPutaway",
        (
          SELECT p.id
            FROM putaways p
           WHERE p.purchase_order_receipt_id = por.id
             AND p.tenant_id = por.tenant_id
             AND p.status IN ('draft','in_progress')
           ORDER BY p.created_at DESC
           LIMIT 1
        ) AS "draftPutawayId",
        COALESCE(rt.line_count, 0) AS "lineCount",
        COALESCE(rt.total_received, 0) AS "totalReceived",
        COALESCE(rt.total_accept, 0) AS "totalAccepted",
        COALESCE(rt.total_hold, 0) AS "totalHold",
        COALESCE(rt.total_reject, 0) AS "totalReject",
        GREATEST(
          COALESCE(rt.total_received, 0)
          - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
          0
        ) AS "qcRemaining",
        COALESCE(rt.putaway_posted, 0) AS "putawayPosted",
        COALESCE(rt.putaway_pending, 0) AS "putawayPending",
        CASE
          WHEN por.status = 'voided' THEN 'failed'
          WHEN COALESCE(rt.total_received, 0) <= 0 THEN 'pending'
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'pending'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'failed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON} THEN 'passed'
          ELSE 'failed'
        END AS "qcStatus",
        CASE
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_accept, 0) <= ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'not_available'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) <= ${STATUS_EPSILON}
            THEN 'not_started'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + ${STATUS_EPSILON} < COALESCE(rt.total_accepted_qty, 0)
            THEN 'pending'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON} THEN 'complete'
          ELSE 'not_available'
        END AS "putawayStatus",
        CASE
          WHEN por.status = 'voided' THEN 'voided'
          WHEN por.status = 'draft' THEN 'draft'
          WHEN COALESCE(rt.total_received, 0) <= 0 THEN 'posted'
          WHEN GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON} THEN 'pending_qc'
          WHEN COALESCE(rt.total_hold, 0) > ${STATUS_EPSILON} THEN 'qc_failed'
          WHEN COALESCE(rt.total_accept, 0) <= ${STATUS_EPSILON} THEN 'qc_failed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) <= ${STATUS_EPSILON}
            THEN 'qc_passed'
          WHEN COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
               AND COALESCE(rt.putaway_posted, 0) + ${STATUS_EPSILON} < COALESCE(rt.total_accepted_qty, 0)
            THEN 'putaway_pending'
          ELSE 'complete'
        END AS "workflowStatus",
        (
          por.status = 'posted'
          AND GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) > ${STATUS_EPSILON}
        ) AS "qcEligible",
        (
          por.status = 'posted'
          AND COALESCE(rt.total_accept, 0) > ${STATUS_EPSILON}
          AND COALESCE(rt.total_hold, 0) <= ${STATUS_EPSILON}
          AND GREATEST(
            COALESCE(rt.total_received, 0)
            - (COALESCE(rt.total_accept, 0) + COALESCE(rt.total_hold, 0) + COALESCE(rt.total_reject, 0)),
            0
          ) <= ${STATUS_EPSILON}
          AND COALESCE(rt.putaway_posted, 0) + COALESCE(rt.putaway_pending, 0) + ${STATUS_EPSILON}
              < COALESCE(rt.total_accepted_qty, 0)
        ) AS "putawayEligible"
      FROM purchase_order_receipts por
      LEFT JOIN purchase_orders po ON po.id = por.purchase_order_id AND po.tenant_id = por.tenant_id
      LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = por.tenant_id
      LEFT JOIN locations loc ON loc.id = por.received_to_location_id AND loc.tenant_id = por.tenant_id
      LEFT JOIN receipt_totals rt ON rt.receipt_id = por.id
      WHERE ${where.join(' AND ')}
    )
    SELECT *
      FROM receipt_status
      ${statusClause}
     ORDER BY "createdAt" DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  if (!options.includeLines || rows.length === 0) {
    return rows;
  }

  const receiptIds = rows.map((row) => row.id);
  const linesResult = await query(
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
      WHERE porl.purchase_order_receipt_id = ANY($1::uuid[]) AND porl.tenant_id = $2
      ORDER BY porl.created_at ASC`,
    [receiptIds, tenantId]
  );
  const lineIds = linesResult.rows.map((line) => line.id);
  const breakdown = await loadQcBreakdown(tenantId, lineIds);
  const totals = await loadPutawayTotals(tenantId, lineIds);

  const linesByReceipt = new Map<string, any[]>();
  for (const line of linesResult.rows) {
    const mapped = mapReceiptLine(line, breakdown, totals);
    const receiptId = line.purchase_order_receipt_id;
    const existing = linesByReceipt.get(receiptId) ?? [];
    existing.push(mapped);
    linesByReceipt.set(receiptId, existing);
  }

  return rows.map((row) => ({
    ...row,
    lines: linesByReceipt.get(row.id) ?? []
  }));
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

export async function voidReceipt(tenantId: string, id: string, actor: { type: 'user' | 'system'; id?: string | null }) {
  return withTransaction(async (client) => {
    const receiptResult = await client.query(
      'SELECT id, status FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (receiptResult.rowCount === 0) {
      throw new Error('RECEIPT_NOT_FOUND');
    }
    const receipt = receiptResult.rows[0];
    if (receipt.status === 'voided') {
      throw new Error('RECEIPT_ALREADY_VOIDED');
    }

    const { rows: putawayRefs } = await client.query(
      `SELECT pl.id,
              pl.status AS line_status,
              p.status AS putaway_status,
              pl.inventory_movement_id
         FROM putaway_lines pl
         JOIN putaways p ON p.id = pl.putaway_id AND p.tenant_id = pl.tenant_id
        WHERE pl.purchase_order_receipt_line_id IN (
              SELECT id FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2
            )
          AND pl.tenant_id = $2`,
      [id, tenantId]
    );
    if (putawayRefs.length > 0) {
      const hasPosted = putawayRefs.some(
        (r) => r.line_status === 'completed' || r.putaway_status === 'completed' || r.inventory_movement_id
      );
      if (hasPosted) {
        throw new Error('RECEIPT_HAS_PUTAWAYS_POSTED');
      }
    }

    await client.query(
      `UPDATE purchase_order_receipts
          SET status = 'voided'
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    await recordAuditLog({
      tenantId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'update',
      entityType: 'purchase_order_receipt',
      entityId: id,
      metadata: { statusFrom: receipt.status, statusTo: 'voided' }
    }, client);

    return fetchReceiptById(tenantId, id, client);
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
