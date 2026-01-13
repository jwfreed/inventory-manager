import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import type { purchaseOrderSchema, purchaseOrderLineSchema, purchaseOrderUpdateSchema } from '../schemas/purchaseOrders.schema';
import { toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';

export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;
export type PurchaseOrderUpdateInput = z.infer<typeof purchaseOrderUpdateSchema>;

const shouldAutoApprove = () => process.env.NODE_ENV !== 'production';

type PurchaseOrderStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'canceled';

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
    receivingLocationId: row.receiving_location_id ?? null,
    receivingLocationCode: row.receiving_location_code ?? null,
    vendorReference: row.vendor_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      purchaseOrderId: line.purchase_order_id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      itemSku: line.item_sku ?? line.sku ?? null,
      itemName: line.item_name ?? null,
      uom: line.uom,
      quantityOrdered: line.quantity_ordered,
      unitCost: line.unit_cost != null ? Number(line.unit_cost) : null,
      unitPrice: line.unit_price != null ? Number(line.unit_price) : null,
      currencyCode: line.currency_code ?? null,
      exchangeRateToBase: line.exchange_rate_to_base != null ? Number(line.exchange_rate_to_base) : null,
      lineAmount: line.line_amount != null ? Number(line.line_amount) : null,
      baseAmount: line.base_amount != null ? Number(line.base_amount) : null,
      notes: line.notes,
      createdAt: line.created_at
    }))
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
            pol.created_at, i.sku AS item_sku, i.name AS item_name
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
      WHERE pol.purchase_order_id = $1 AND pol.tenant_id = $2
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
            unit_cost, unit_price, currency_code, exchange_rate_to_base, line_amount, base_amount, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
              unit_cost, unit_price, currency_code, exchange_rate_to_base, line_amount, base_amount, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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

    const updated = await client.query(
      `UPDATE purchase_orders
          SET status = 'canceled',
              updated_at = $1
        WHERE id = $2 AND tenant_id = $3
        RETURNING *`,
      [new Date(), id, tenantId]
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

export async function getPurchaseOrderById(tenantId: string, id: string) {
  const poResult = await query(
    `SELECT po.*,
            loc.code AS receiving_location_code,
            ship.code AS ship_to_location_code
       FROM purchase_orders po
       LEFT JOIN locations loc ON loc.id = po.receiving_location_id AND loc.tenant_id = po.tenant_id
       LEFT JOIN locations ship ON ship.id = po.ship_to_location_id AND ship.tenant_id = po.tenant_id
      WHERE po.id = $1 AND po.tenant_id = $2`,
    [id, tenantId]
  );
  if (poResult.rowCount === 0) {
    return null;
  }
  const lineResult = await query(
    `SELECT pol.*, i.sku AS item_sku, i.name AS item_name
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id AND i.tenant_id = pol.tenant_id
      WHERE pol.purchase_order_id = $1 AND pol.tenant_id = $2
      ORDER BY pol.line_number ASC`,
    [id, tenantId]
  );
  return mapPurchaseOrder(poResult.rows[0], lineResult.rows);
}

export async function listPurchaseOrders(tenantId: string, limit: number, offset: number) {
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
            po.created_at,
            po.updated_at
       FROM purchase_orders po
       LEFT JOIN vendors v ON v.id = po.vendor_id AND v.tenant_id = po.tenant_id
       LEFT JOIN locations loc ON loc.id = po.ship_to_location_id AND loc.tenant_id = po.tenant_id
       LEFT JOIN locations recv ON recv.id = po.receiving_location_id AND recv.tenant_id = po.tenant_id
      WHERE po.tenant_id = $1
       ORDER BY po.created_at DESC
       LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return rows.map(mapPurchaseOrderSummary);
}
