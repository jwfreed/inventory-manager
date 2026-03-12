import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import type {
  purchaseOrderSchema,
  purchaseOrderCloseSchema,
  purchaseOrderLineCloseSchema,
  purchaseOrderLineSchema,
  purchaseOrderUpdateSchema
} from '../schemas/purchaseOrders.schema';
import { toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { updatePoStatusFromReceipts } from './status/purchaseOrdersStatus.service';

export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;
export type PurchaseOrderUpdateInput = z.infer<typeof purchaseOrderUpdateSchema>;
export type PurchaseOrderCloseInput = z.infer<typeof purchaseOrderCloseSchema>;
export type PurchaseOrderLineCloseInput = z.infer<typeof purchaseOrderLineCloseSchema>;

const shouldAutoApprove = () => process.env.NODE_ENV !== 'production';

type PurchaseOrderStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'canceled';

type PurchaseOrderLineStatus = 'open' | 'complete' | 'closed_short' | 'cancelled';

function validateReadyForSubmit(input: {
  vendorId?: string | null;
  shipToLocationId?: string | null;
  receivingLocationId?: string | null;
  expectedDate?: string | null;
  lines?: { quantityOrdered?: number | null }[];
}) {
  if (!input.vendorId) throw new Error('PO_SUBMIT_MISSING_VENDOR');
  if (!input.shipToLocationId) throw new Error('PO_SUBMIT_MISSING_SHIP_TO');
  if (!input.receivingLocationId) throw new Error('PO_SUBMIT_MISSING_RECEIVING');
  if (!input.expectedDate) throw new Error('PO_SUBMIT_MISSING_EXPECTED_DATE');
  if (!input.lines || input.lines.length === 0) throw new Error('PO_SUBMIT_MISSING_LINES');
  const hasInvalidQty = input.lines.some((line) => (line.quantityOrdered ?? 0) <= 0);
  if (hasInvalidQty) throw new Error('PO_SUBMIT_INVALID_QUANTITY');
}

function assertAllowedStatusTransition(current: PurchaseOrderStatus, requested: PurchaseOrderStatus) {
  if (current === requested) return;
  if (current === 'draft' && requested === 'submitted') return;
  if (current === 'submitted' && requested === 'approved') return;
  throw new Error('PO_STATUS_INVALID_TRANSITION');
}

function mapPurchaseOrderLine(line: any) {
  return {
    id: line.id,
    purchaseOrderId: line.purchase_order_id,
    lineNumber: line.line_number,
    itemId: line.item_id,
    itemSku: line.item_sku ?? line.sku ?? null,
    itemName: line.item_name ?? null,
    uom: line.uom,
    quantityOrdered: line.quantity_ordered,
    quantityReceived: line.quantity_received != null ? Number(line.quantity_received) : 0,
    status: (line.status ?? 'open') as PurchaseOrderLineStatus,
    closedReason: line.closed_reason ?? null,
    closedNotes: line.closed_notes ?? null,
    closedAt: line.closed_at ?? null,
    closedByUserId: line.closed_by_user_id ?? null,
    unitCost: line.unit_cost != null ? Number(line.unit_cost) : null,
    unitPrice: line.unit_price != null ? Number(line.unit_price) : null,
    currencyCode: line.currency_code ?? null,
    exchangeRateToBase: line.exchange_rate_to_base != null ? Number(line.exchange_rate_to_base) : null,
    lineAmount: line.line_amount != null ? Number(line.line_amount) : null,
    baseAmount: line.base_amount != null ? Number(line.base_amount) : null,
    overReceiptTolerancePct: line.over_receipt_tolerance_pct != null ? Number(line.over_receipt_tolerance_pct) : 0,
    requiresLot: !!line.requires_lot,
    requiresSerial: !!line.requires_serial,
    requiresQc: !!line.requires_qc,
    notes: line.notes,
    createdAt: line.created_at
  };
}

function normalizeLineCloseAs(value: PurchaseOrderLineCloseInput['closeAs']): PurchaseOrderLineStatus {
  return value === 'short' ? 'closed_short' : 'cancelled';
}

function normalizePoCloseAs(value: PurchaseOrderCloseInput['closeAs']): 'closed' | 'canceled' {
  return value === 'cancelled' ? 'canceled' : 'closed';
}

export function mapPurchaseOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code ?? null,
    vendorName: row.vendor_name ?? null,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    shipToLocationId: row.ship_to_location_id,
    shipToLocationCode: row.ship_to_location_code ?? null,
    shipToLocationName: row.ship_to_location_name ?? null,
    receivingLocationId: row.receiving_location_id ?? null,
    receivingLocationCode: row.receiving_location_code ?? null,
    receivingLocationName: row.receiving_location_name ?? null,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    closeReason: row.close_reason ?? null,
    closeNotes: row.close_notes ?? null,
    closedAt: row.closed_at ?? null,
    closedByUserId: row.closed_by_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map(mapPurchaseOrderLine)
  };
}

function mapPurchaseOrderSummary(row: any) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code ?? null,
    vendorName: row.vendor_name ?? null,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    shipToLocationId: row.ship_to_location_id,
    shipToLocationCode: row.ship_to_location_code ?? null,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    closeReason: row.close_reason ?? null,
    closedAt: row.closed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizePurchaseOrderLines(lines: PurchaseOrderLineInput[]) {
  const lineNumbers = new Set<number>();
  const normalized = lines.map((line, index) => {
    const number = line.lineNumber ?? index + 1;
    if (lineNumbers.has(number)) {
      throw new Error('PO_DUPLICATE_LINE_NUMBERS');
    }
    lineNumbers.add(number);
    const quantityOrdered = toNumber(line.quantityOrdered);
    return { ...line, lineNumber: number, quantityOrdered, uom: line.uom };
  });
  return normalized;
}

async function assertPurchasableItems(client: PoolClient, tenantId: string, itemIds: string[]) {
  const distinctItemIds = Array.from(new Set(itemIds));
  if (distinctItemIds.length === 0) return;

  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM items
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND is_purchasable = true`,
    [tenantId, distinctItemIds]
  );

  if (rows.length !== distinctItemIds.length) {
    throw new Error('PO_NON_PURCHASABLE_ITEM');
  }
}

async function generatePoNumber(client: PoolClient) {
  const { rows } = await client.query(`SELECT nextval('po_number_seq') AS seq`);
  const seq = Number(rows[0].seq ?? 0);
  const padded = String(seq).padStart(6, '0');
  return `PO-${padded}`;
}

async function loadLinesWithItems(client: PoolClient, tenantId: string, poId: string) {
  const { rows } = await client.query(
    `SELECT pol.id, pol.purchase_order_id, pol.line_number, pol.item_id, pol.uom,
            pol.quantity_ordered, pol.unit_cost, pol.unit_price, pol.currency_code,
            pol.exchange_rate_to_base, pol.line_amount, pol.base_amount, pol.notes,
            pol.created_at, pol.over_receipt_tolerance_pct, pol.status, pol.closed_reason,
            pol.closed_notes, pol.closed_at, pol.closed_by_user_id,
            COALESCE(SUM(
              CASE
                WHEN COALESCE(por.status, 'posted') <> 'voided' THEN porl.quantity_received
                ELSE 0
              END
            ), 0) AS quantity_received,
            i.sku AS item_sku, i.name AS item_name, i.requires_lot, i.requires_serial, i.requires_qc
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipt_lines porl
         ON porl.purchase_order_line_id = pol.id
        AND porl.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipts por
         ON por.id = porl.purchase_order_receipt_id
        AND por.tenant_id = porl.tenant_id
      WHERE pol.purchase_order_id = $1 AND pol.tenant_id = $2
      GROUP BY pol.id, i.sku, i.name, i.requires_lot, i.requires_serial, i.requires_qc
      ORDER BY pol.line_number ASC`,
    [poId, tenantId]
  );
  return rows;
}

export async function createPurchaseOrder(
  tenantId: string,
  data: PurchaseOrderInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const poId = uuidv4();
  const now = new Date();
  const requestedStatus = data.status ?? 'draft';
  const status = requestedStatus === 'submitted' && shouldAutoApprove() ? 'approved' : requestedStatus;
  const normalizedLines = normalizePurchaseOrderLines(data.lines);

  if (requestedStatus === 'submitted' || requestedStatus === 'approved') {
    validateReadyForSubmit({
      vendorId: data.vendorId,
      shipToLocationId: data.shipToLocationId ?? null,
      receivingLocationId: data.receivingLocationId ?? null,
      expectedDate: data.expectedDate ?? null,
      lines: normalizedLines
    });
  }

  return withTransaction(async (client) => {
    const poNumber = (data.poNumber ?? '').trim() || (await generatePoNumber(client));
    await assertPurchasableItems(client, tenantId, normalizedLines.map((line) => line.itemId));
    const insertedOrder = await client.query(
      `INSERT INTO purchase_orders (
          id, tenant_id, po_number, vendor_id, status, order_date, expected_date,
          ship_to_location_id, receiving_location_id, vendor_reference, notes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING *`,
      [
        poId,
        tenantId,
        poNumber,
        data.vendorId,
        status,
        data.orderDate ?? null,
        data.expectedDate ?? null,
        data.shipToLocationId ?? null,
        data.receivingLocationId ?? null,
        data.vendorReference ?? null,
        data.notes ?? null,
        now
      ]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO purchase_order_lines (
            id, tenant_id, purchase_order_id, line_number, item_id, uom, quantity_ordered,
            unit_cost, unit_price, currency_code, exchange_rate_to_base, line_amount, base_amount, over_receipt_tolerance_pct, notes, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open')
         RETURNING id`,
        [
          uuidv4(),
          tenantId,
          poId,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.quantityOrdered,
          line.unitCost ?? null,
          line.unitPrice ?? null,
          line.currencyCode ?? null,
          line.exchangeRateToBase ?? null,
          line.lineAmount ?? null,
          line.baseAmount ?? null,
          line.overReceiptTolerancePct ?? 0,
          line.notes ?? null
        ]
      );
    }

    const enrichedLines = await loadLinesWithItems(client, tenantId, poId);
    const mapped = mapPurchaseOrder(insertedOrder.rows[0], enrichedLines);
    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'create',
          entityType: 'purchase_order',
          entityId: poId,
          occurredAt: now,
          metadata: {
            status: mapped.status,
            lineCount: enrichedLines.length
          }
        },
        client
      );
    }
    return mapped;
  });
}

export async function updatePurchaseOrder(
  tenantId: string,
  id: string,
  data: PurchaseOrderUpdateInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  const now = new Date();
  const normalizedLines = data.lines ? normalizePurchaseOrderLines(data.lines) : null;

  return withTransaction(async (client) => {
    const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }
    const currentStatus = (poResult.rows[0]?.status ?? 'draft') as PurchaseOrderStatus;
    const requestedStatus = (data.status ?? currentStatus) as PurchaseOrderStatus;

    if (data.status === 'canceled') {
      throw new Error('PO_CANCEL_USE_ENDPOINT');
    }
    if (data.status === 'approved' && currentStatus !== 'submitted') {
      throw new Error('PO_APPROVE_USE_ENDPOINT');
    }
    if (data.status === 'received' || data.status === 'closed' || data.status === 'partially_received') {
      throw new Error('PO_STATUS_MANAGED_BY_RECEIPTS');
    }

    assertAllowedStatusTransition(currentStatus, requestedStatus === 'approved' && shouldAutoApprove() ? 'approved' : requestedStatus);

    if (currentStatus !== 'draft') {
      const attemptedStructuralChange =
        data.vendorId !== undefined ||
        data.orderDate !== undefined ||
        data.expectedDate !== undefined ||
        data.shipToLocationId !== undefined ||
        data.receivingLocationId !== undefined ||
        normalizedLines !== null;
      if (attemptedStructuralChange) {
        throw new Error(normalizedLines ? 'PO_LINES_LOCKED' : 'PO_EDIT_LOCKED');
      }
    }

    if (requestedStatus === 'submitted') {
      const existingLines = normalizedLines ?? (await loadLinesWithItems(client, tenantId, id));
      validateReadyForSubmit({
        vendorId: data.vendorId ?? poResult.rows[0]?.vendor_id,
        shipToLocationId: data.shipToLocationId ?? poResult.rows[0]?.ship_to_location_id ?? null,
        receivingLocationId: data.receivingLocationId ?? poResult.rows[0]?.receiving_location_id ?? null,
        expectedDate: data.expectedDate ?? poResult.rows[0]?.expected_date ?? null,
        lines: existingLines.map((line) => ({ quantityOrdered: line.quantity_ordered }))
      });
    }
    if (normalizedLines) {
      await assertPurchasableItems(client, tenantId, normalizedLines.map((line) => line.itemId));
    }

    const status = requestedStatus === 'submitted' && shouldAutoApprove() ? 'approved' : requestedStatus;

    const updated = await client.query(
      `UPDATE purchase_orders
          SET status = $2,
              order_date = $3,
              expected_date = $4,
              ship_to_location_id = $5,
              receiving_location_id = $6,
              vendor_reference = $7,
              notes = $8,
              updated_at = $9
        WHERE id = $1 AND tenant_id = $10
        RETURNING *`,
      [
        id,
        status,
        data.orderDate ?? null,
        data.expectedDate ?? null,
        data.shipToLocationId ?? null,
        data.receivingLocationId ?? null,
        data.vendorReference ?? null,
        data.notes ?? null,
        now,
        tenantId
      ]
    );

    if (normalizedLines) {
      await client.query(
        'DELETE FROM purchase_order_lines WHERE purchase_order_id = $1 AND tenant_id = $2',
        [id, tenantId]
      );
      for (const line of normalizedLines) {
        await client.query(
          `INSERT INTO purchase_order_lines (
              id, tenant_id, purchase_order_id, line_number, item_id, uom, quantity_ordered,
              unit_cost, unit_price, currency_code, exchange_rate_to_base, line_amount, base_amount, over_receipt_tolerance_pct, notes, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open')`,
          [
            uuidv4(),
            tenantId,
            id,
            line.lineNumber,
            line.itemId,
            line.uom,
            line.quantityOrdered,
            line.unitCost ?? null,
            line.unitPrice ?? null,
            line.currencyCode ?? null,
            line.exchangeRateToBase ?? null,
            line.lineAmount ?? null,
            line.baseAmount ?? null,
            line.overReceiptTolerancePct ?? null,
            line.notes ?? null
          ]
        );
      }
    }

    const lines = await loadLinesWithItems(client, tenantId, id);
    const mapped = mapPurchaseOrder(updated.rows[0], lines);
    if (actor) {
      const changedFields = Object.keys(data).filter((key) => data[key as keyof PurchaseOrderUpdateInput] !== undefined);
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'purchase_order',
          entityId: id,
          occurredAt: now,
          metadata: {
            statusFrom: currentStatus,
            statusTo: mapped.status,
            changedFields,
            lineCount: lines.length
          }
        },
        client
      );
    }
    return mapped;
  });
}

export async function deletePurchaseOrder(tenantId: string, id: string) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM purchase_order_lines WHERE purchase_order_id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    await client.query('DELETE FROM purchase_orders WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  });
}

export async function cancelPurchaseOrder(
  tenantId: string,
  id: string,
  actor: { type: 'user' | 'system'; id?: string | null }
) {
  return withTransaction(async (client) => {
    const closedByUserId = actor.type === 'user' ? actor.id ?? null : null;
    const poResult = await client.query('SELECT id, status FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [
      id,
      tenantId
    ]);
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }
    const po = poResult.rows[0];
    if (po.status === 'canceled') {
      throw new Error('PO_ALREADY_CANCELED');
    }
    if (po.status === 'received' || po.status === 'closed') {
      throw new Error('PO_NOT_ELIGIBLE');
    }

    const receiptResult = await client.query(
      'SELECT id FROM purchase_order_receipts WHERE purchase_order_id = $1 AND tenant_id = $2 LIMIT 1',
      [id, tenantId]
    );
    if ((receiptResult.rowCount ?? 0) > 0) {
      throw new Error('PO_HAS_RECEIPTS');
    }

    const now = new Date();
    const updated = await client.query(
      `UPDATE purchase_orders
          SET status = 'canceled',
              close_reason = COALESCE(close_reason, 'canceled'),
              closed_at = COALESCE(closed_at, $1),
              closed_by_user_id = COALESCE(closed_by_user_id, $4),
              updated_at = $1
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [now, id, tenantId, closedByUserId]
    );

    await client.query(
      `UPDATE purchase_order_lines
          SET status = CASE
                WHEN status = 'complete' THEN status
                ELSE 'cancelled'
              END,
              closed_reason = CASE
                WHEN status = 'complete' THEN closed_reason
                ELSE COALESCE(closed_reason, 'po_canceled')
              END,
              closed_at = CASE
                WHEN status = 'complete' THEN closed_at
                ELSE COALESCE(closed_at, $3)
              END,
              closed_by_user_id = CASE
                WHEN status = 'complete' THEN closed_by_user_id
                ELSE COALESCE(closed_by_user_id, $4)
              END
        WHERE purchase_order_id = $1
          AND tenant_id = $2`,
      [id, tenantId, now, closedByUserId]
    );

    await recordAuditLog(
      {
        tenantId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'update',
        entityType: 'purchase_order',
        entityId: id,
        metadata: { statusFrom: po.status, statusTo: 'canceled' }
      },
      client
    );

    const lines = await loadLinesWithItems(client, tenantId, id);
    return mapPurchaseOrder(updated.rows[0], lines);
  });
}

export async function approvePurchaseOrder(
  tenantId: string,
  id: string,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  return withTransaction(async (client) => {
    const now = new Date();
    const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [
      id,
      tenantId
    ]);
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }
    const po = poResult.rows[0];
    if (po.status === 'approved') {
      throw new Error('PO_ALREADY_APPROVED');
    }
    if (po.status === 'closed' || po.status === 'canceled') {
      throw new Error('PO_NOT_ELIGIBLE');
    }
    if (po.status !== 'submitted') {
      throw new Error('PO_NOT_SUBMITTED');
    }

    const updated = await client.query(
      `UPDATE purchase_orders
          SET status = 'approved',
              updated_at = $1
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [now, id, tenantId]
    );
    const lines = await loadLinesWithItems(client, tenantId, id);
    const mapped = mapPurchaseOrder(updated.rows[0], lines);
    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'purchase_order',
          entityId: id,
          occurredAt: now,
          metadata: { statusFrom: po.status, statusTo: mapped.status }
        },
        client
      );
    }
    return mapped;
  });
}

async function loadPurchaseOrderWithClient(client: PoolClient, tenantId: string, id: string) {
  const poResult = await client.query(
    `SELECT po.*,
            v.code AS vendor_code,
            v.name AS vendor_name,
            loc.code AS receiving_location_code,
            loc.name AS receiving_location_name,
            ship.code AS ship_to_location_code,
            ship.name AS ship_to_location_name
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = po.tenant_id
       LEFT JOIN locations loc ON loc.id = po.receiving_location_id AND loc.tenant_id = po.tenant_id
       LEFT JOIN locations ship ON ship.id = po.ship_to_location_id AND ship.tenant_id = po.tenant_id
      WHERE po.id = $1
        AND po.tenant_id = $2`,
    [id, tenantId]
  );
  if (poResult.rowCount === 0) {
    return null;
  }
  const lines = await loadLinesWithItems(client, tenantId, id);
  return mapPurchaseOrder(poResult.rows[0], lines);
}

export async function closePurchaseOrderLine(
  tenantId: string,
  lineId: string,
  data: PurchaseOrderLineCloseInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  return withTransaction(async (client) => {
    const now = new Date();
    const closedByUserId = actor?.type === 'user' ? actor.id ?? null : null;
    const lineLocatorResult = await client.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id
         FROM purchase_order_lines
        WHERE id = $1
          AND tenant_id = $2`,
      [lineId, tenantId]
    );
    if (lineLocatorResult.rowCount === 0) {
      throw new Error('PO_LINE_NOT_FOUND');
    }
    const poId = lineLocatorResult.rows[0].purchase_order_id;

    const poResult = await client.query<{ status: string }>(
      `SELECT status
         FROM purchase_orders
        WHERE id = $1
          AND tenant_id = $2
        FOR UPDATE`,
      [poId, tenantId]
    );
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }

    const lineResult = await client.query<{ status: string }>(
      `SELECT status
         FROM purchase_order_lines
        WHERE id = $1
          AND tenant_id = $2
          AND purchase_order_id = $3
        FOR UPDATE`,
      [lineId, tenantId, poId]
    );
    if (lineResult.rowCount === 0) {
      throw new Error('PO_LINE_NOT_FOUND');
    }

    const poStatus = String(poResult.rows[0].status ?? '');
    const currentStatus = String(lineResult.rows[0].status ?? 'open') as PurchaseOrderLineStatus;
    const nextStatus = normalizeLineCloseAs(data.closeAs);

    if (poStatus === 'canceled' || poStatus === 'closed') {
      throw new Error('PO_NOT_ELIGIBLE');
    }
    if (poStatus === 'received') {
      throw new Error('PO_LINE_NOT_CLOSABLE');
    }

    if (currentStatus === nextStatus) {
      const purchaseOrder = await loadPurchaseOrderWithClient(client, tenantId, poId);
      if (!purchaseOrder) throw new Error('PO_NOT_FOUND');
      const line = purchaseOrder.lines.find((entry: any) => entry.id === lineId);
      return { purchaseOrder, line };
    }
    if (currentStatus === 'complete') {
      throw new Error('PO_LINE_NOT_CLOSABLE');
    }
    if (currentStatus === 'closed_short' || currentStatus === 'cancelled') {
      throw new Error('PO_LINE_ALREADY_CLOSED');
    }

    await client.query(
      `UPDATE purchase_order_lines
          SET status = $1,
              closed_reason = $2,
              closed_notes = $3,
              closed_at = $4,
              closed_by_user_id = $5
        WHERE id = $6
          AND tenant_id = $7`,
      [nextStatus, data.reason.trim(), data.notes ?? null, now, closedByUserId, lineId, tenantId]
    );

    await updatePoStatusFromReceipts(tenantId, poId, client);

    await client.query(
      `UPDATE purchase_orders
          SET close_reason = CASE
                WHEN status = 'closed' THEN COALESCE(close_reason, $1)
                ELSE close_reason
              END,
              close_notes = CASE
                WHEN status = 'closed' THEN COALESCE(close_notes, $2)
                ELSE close_notes
              END,
              closed_at = CASE
                WHEN status = 'closed' THEN COALESCE(closed_at, $3)
                ELSE closed_at
              END,
              closed_by_user_id = CASE
                WHEN status = 'closed' THEN COALESCE(closed_by_user_id, $4)
                ELSE closed_by_user_id
              END,
              updated_at = now()
        WHERE id = $5
          AND tenant_id = $6`,
      [data.reason.trim(), data.notes ?? null, now, closedByUserId, poId, tenantId]
    );

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'purchase_order_line',
          entityId: lineId,
          occurredAt: now,
          metadata: {
            purchaseOrderId: poId,
            statusTo: nextStatus,
            reason: data.reason.trim()
          }
        },
        client
      );
    }

    const purchaseOrder = await loadPurchaseOrderWithClient(client, tenantId, poId);
    if (!purchaseOrder) throw new Error('PO_NOT_FOUND');
    const line = purchaseOrder.lines.find((entry: any) => entry.id === lineId);
    return { purchaseOrder, line };
  });
}

export async function closePurchaseOrderByAction(
  tenantId: string,
  id: string,
  data: PurchaseOrderCloseInput,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  return withTransaction(async (client) => {
    const now = new Date();
    const closedByUserId = actor?.type === 'user' ? actor.id ?? null : null;
    const normalizedCloseAs = normalizePoCloseAs(data.closeAs);
    const poResult = await client.query<{ status: string }>(
      `SELECT status
         FROM purchase_orders
        WHERE id = $1
          AND tenant_id = $2
        FOR UPDATE`,
      [id, tenantId]
    );
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }

    const poStatus = poResult.rows[0].status;
    if (poStatus === normalizedCloseAs) {
      const purchaseOrder = await loadPurchaseOrderWithClient(client, tenantId, id);
      if (!purchaseOrder) throw new Error('PO_NOT_FOUND');
      return purchaseOrder;
    }
    if (poStatus === 'canceled' || poStatus === 'closed' || poStatus === 'received') {
      throw new Error('PO_NOT_ELIGIBLE');
    }

    const receivedResult = await client.query<{ has_received: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM purchase_order_receipt_lines porl
           JOIN purchase_order_receipts por
             ON por.id = porl.purchase_order_receipt_id
            AND por.tenant_id = porl.tenant_id
          WHERE por.tenant_id = $1
            AND por.purchase_order_id = $2
            AND COALESCE(por.status, 'posted') <> 'voided'
            AND porl.quantity_received > 0
       ) AS has_received`,
      [tenantId, id]
    );
    const hasReceived = Boolean(receivedResult.rows[0]?.has_received);

    if (normalizedCloseAs === 'canceled' && hasReceived) {
      throw new Error('PO_CANCEL_WITH_RECEIPTS_FORBIDDEN');
    }
    if (normalizedCloseAs === 'closed' && !['approved', 'partially_received'].includes(poStatus)) {
      throw new Error('PO_NOT_ELIGIBLE');
    }

    if (normalizedCloseAs === 'closed') {
      await client.query(
        `UPDATE purchase_order_lines
            SET status = CASE WHEN status = 'open' THEN 'closed_short' ELSE status END,
                closed_reason = CASE
                  WHEN status = 'open' THEN $1
                  ELSE closed_reason
                END,
                closed_notes = CASE
                  WHEN status = 'open' THEN $2
                  ELSE closed_notes
                END,
                closed_at = CASE
                  WHEN status = 'open' THEN $3
                  ELSE closed_at
                END,
                closed_by_user_id = CASE
                  WHEN status = 'open' THEN $4
                  ELSE closed_by_user_id
                END
          WHERE purchase_order_id = $5
            AND tenant_id = $6`,
        [data.reason.trim(), data.notes ?? null, now, closedByUserId, id, tenantId]
      );
      await updatePoStatusFromReceipts(tenantId, id, client);
      await client.query(
        `UPDATE purchase_orders
            SET status = 'closed',
                close_reason = $1,
                close_notes = $2,
                closed_at = $3,
                closed_by_user_id = $4,
                updated_at = now()
          WHERE id = $5
            AND tenant_id = $6`,
        [data.reason.trim(), data.notes ?? null, now, closedByUserId, id, tenantId]
      );
    } else {
      await client.query(
        `UPDATE purchase_order_lines
            SET status = CASE
                  WHEN status = 'complete' THEN status
                  ELSE 'cancelled'
                END,
                closed_reason = CASE
                  WHEN status = 'complete' THEN closed_reason
                  ELSE $1
                END,
                closed_notes = CASE
                  WHEN status = 'complete' THEN closed_notes
                  ELSE $2
                END,
                closed_at = CASE
                  WHEN status = 'complete' THEN closed_at
                  ELSE $3
                END,
                closed_by_user_id = CASE
                  WHEN status = 'complete' THEN closed_by_user_id
                  ELSE $4
                END
          WHERE purchase_order_id = $5
            AND tenant_id = $6`,
        [data.reason.trim(), data.notes ?? null, now, closedByUserId, id, tenantId]
      );
      await client.query(
        `UPDATE purchase_orders
            SET status = 'canceled',
                close_reason = $1,
                close_notes = $2,
                closed_at = $3,
                closed_by_user_id = $4,
                updated_at = now()
          WHERE id = $5
            AND tenant_id = $6`,
        [data.reason.trim(), data.notes ?? null, now, closedByUserId, id, tenantId]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'purchase_order',
          entityId: id,
          occurredAt: now,
          metadata: {
            statusTo: normalizedCloseAs,
            reason: data.reason.trim()
          }
        },
        client
      );
    }

    const purchaseOrder = await loadPurchaseOrderWithClient(client, tenantId, id);
    if (!purchaseOrder) {
      throw new Error('PO_NOT_FOUND');
    }
    return purchaseOrder;
  });
}

export async function getPurchaseOrderById(tenantId: string, id: string) {
  const poResult = await query(
    `SELECT po.*,
            v.code AS vendor_code,
            v.name AS vendor_name,
            loc.code AS receiving_location_code,
            loc.name AS receiving_location_name,
            ship.code AS ship_to_location_code,
            ship.name AS ship_to_location_name
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = po.tenant_id
       LEFT JOIN locations loc ON loc.id = po.receiving_location_id AND loc.tenant_id = po.tenant_id
       LEFT JOIN locations ship ON ship.id = po.ship_to_location_id AND ship.tenant_id = po.tenant_id
      WHERE po.id = $1 AND po.tenant_id = $2`,
    [id, tenantId]
  );
  if (poResult.rowCount === 0) {
    return null;
  }
  const lineResult = await query(
    `SELECT pol.*, i.sku AS item_sku, i.name AS item_name,
            COALESCE(SUM(
              CASE
                WHEN COALESCE(por.status, 'posted') <> 'voided' THEN porl.quantity_received
                ELSE 0
              END
            ), 0) AS quantity_received
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipt_lines porl
         ON porl.purchase_order_line_id = pol.id
        AND porl.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipts por
         ON por.id = porl.purchase_order_receipt_id
        AND por.tenant_id = porl.tenant_id
      WHERE pol.purchase_order_id = $1 AND pol.tenant_id = $2
      GROUP BY pol.id, i.sku, i.name
      ORDER BY pol.line_number ASC`,
    [id, tenantId]
  );
  return mapPurchaseOrder(poResult.rows[0], lineResult.rows);
}

export async function getPurchaseOrderByLineId(tenantId: string, lineId: string) {
  const line = await query<{ purchase_order_id: string }>(
    `SELECT purchase_order_id
       FROM purchase_order_lines
      WHERE id = $1
        AND tenant_id = $2`,
    [lineId, tenantId]
  );
  if (line.rowCount === 0) {
    return null;
  }
  return getPurchaseOrderById(tenantId, line.rows[0].purchase_order_id);
}

export async function listPurchaseOrders(tenantId: string, limit: number, offset: number, search?: string) {
  const params: Array<string | number> = [tenantId];
  let searchClause = '';
  if (search) {
    params.push(`%${search}%`);
    const searchParam = params.length;
    searchClause = `
      AND (
        po.po_number ILIKE $${searchParam}
        OR v.code ILIKE $${searchParam}
        OR v.name ILIKE $${searchParam}
        OR EXISTS (
          SELECT 1
            FROM purchase_order_lines pol_search
            JOIN items i_search
              ON i_search.id = pol_search.item_id
             AND i_search.tenant_id = pol_search.tenant_id
           WHERE pol_search.purchase_order_id = po.id
             AND pol_search.tenant_id = po.tenant_id
             AND (
               i_search.sku ILIKE $${searchParam}
               OR i_search.name ILIKE $${searchParam}
             )
        )
      )
    `;
  }

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT po.id,
            po.po_number,
            po.vendor_id,
            v.code AS vendor_code,
            v.name AS vendor_name,
            po.status,
            po.order_date,
            po.expected_date,
            po.ship_to_location_id,
            loc.code AS ship_to_location_code,
            po.receiving_location_id,
            recv.code AS receiving_location_code,
            po.vendor_reference,
            po.notes,
            po.close_reason,
            po.closed_at,
            po.created_at,
            po.updated_at
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = po.tenant_id
       LEFT JOIN locations loc ON loc.id = po.ship_to_location_id AND loc.tenant_id = po.tenant_id
       LEFT JOIN locations recv ON recv.id = po.receiving_location_id AND recv.tenant_id = po.tenant_id
      WHERE po.tenant_id = $1
       ${searchClause}
       ORDER BY po.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(mapPurchaseOrderSummary);
}
