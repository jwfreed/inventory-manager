import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { recordAuditLog } from '../lib/audit';

export interface VendorInvoiceInput {
  invoiceNumber?: string;
  vendorId: string;
  purchaseOrderId?: string;
  invoiceDate: string;
  dueDate: string;
  glDate?: string;
  currency?: string;
  exchangeRate?: number;
  subtotal: number;
  taxAmount?: number;
  freightAmount?: number;
  discountAmount?: number;
  paymentTermId?: string;
  vendorInvoiceNumber?: string;
  notes?: string;
  lines: VendorInvoiceLineInput[];
}

export interface VendorInvoiceLineInput {
  lineNumber: number;
  purchaseOrderLineId?: string;
  receiptLineId?: string;
  itemId?: string;
  description: string;
  quantity: number;
  uom: string;
  unitPrice: number;
  taxAmount?: number;
  notes?: string;
}

export interface VendorInvoiceUpdateInput {
  invoiceDate?: string;
  dueDate?: string;
  glDate?: string;
  subtotal?: number;
  taxAmount?: number;
  freightAmount?: number;
  discountAmount?: number;
  paymentTermId?: string;
  vendorInvoiceNumber?: string;
  notes?: string;
}

export async function createVendorInvoice(
  tenantId: string,
  data: VendorInvoiceInput,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const invoiceId = uuidv4();
    const now = new Date();

    // Calculate total amount
    const subtotal = data.subtotal;
    const taxAmount = data.taxAmount ?? 0;
    const freightAmount = data.freightAmount ?? 0;
    const discountAmount = data.discountAmount ?? 0;
    const totalAmount = subtotal + taxAmount + freightAmount - discountAmount;

    // Generate invoice number if not provided
    let invoiceNumber = data.invoiceNumber;
    if (!invoiceNumber) {
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '^INV-([0-9]+)$') AS INTEGER)), 0) + 1 AS next_num
         FROM vendor_invoices
         WHERE tenant_id = $1 AND invoice_number ~ '^INV-[0-9]+$'`,
        [tenantId]
      );
      invoiceNumber = `INV-${String(seqRows[0].next_num).padStart(6, '0')}`;
    }

    // Insert invoice
    const { rows: invoiceRows } = await client.query(
      `INSERT INTO vendor_invoices (
        id, tenant_id, invoice_number, vendor_id, purchase_order_id,
        invoice_date, due_date, gl_date, currency, exchange_rate,
        subtotal, tax_amount, freight_amount, discount_amount, total_amount,
        status, payment_term_id, vendor_invoice_number, notes,
        created_at, updated_at, created_by_user_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $20, $21
      ) RETURNING *`,
      [
        invoiceId,
        tenantId,
        invoiceNumber,
        data.vendorId,
        data.purchaseOrderId ?? null,
        data.invoiceDate,
        data.dueDate,
        data.glDate ?? null,
        data.currency ?? 'USD',
        data.exchangeRate ?? 1.0,
        subtotal,
        taxAmount,
        freightAmount,
        discountAmount,
        totalAmount,
        'draft',
        data.paymentTermId ?? null,
        data.vendorInvoiceNumber ?? null,
        data.notes ?? null,
        now,
        actor?.type === 'user' ? actor.id : null,
      ]
    );

    // Insert invoice lines
    for (const line of data.lines) {
      const lineId = uuidv4();
      const lineAmount = line.quantity * line.unitPrice;

      await client.query(
        `INSERT INTO vendor_invoice_lines (
          id, tenant_id, vendor_invoice_id, line_number,
          purchase_order_line_id, receipt_line_id, item_id,
          description, quantity, uom, unit_price, line_amount, tax_amount, notes,
          created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15
        )`,
        [
          lineId,
          tenantId,
          invoiceId,
          line.lineNumber,
          line.purchaseOrderLineId ?? null,
          line.receiptLineId ?? null,
          line.itemId ?? null,
          line.description,
          line.quantity,
          line.uom,
          line.unitPrice,
          lineAmount,
          line.taxAmount ?? 0,
          line.notes ?? null,
          now,
        ]
      );
    }

    // Audit log
    await recordAuditLog({
      tenantId,
      actorType: actor?.type ?? 'system',
      actorId: actor?.id,
      action: 'create',
      entityType: 'vendor_invoice',
      entityId: invoiceId
    }, client);

    return invoiceRows[0];
  });
}

export async function listVendorInvoices(tenantId: string, filters?: {
  status?: string;
  vendorId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}) {
  let sql = `
    SELECT 
      vi.*,
      v.code AS vendor_code,
      v.name AS vendor_name,
      po.po_number,
      (
        SELECT COALESCE(SUM(vpa.applied_amount + vpa.discount_taken), 0)
        FROM vendor_payment_applications vpa
        WHERE vpa.vendor_invoice_id = vi.id AND vpa.tenant_id = vi.tenant_id
      ) AS amount_paid,
      (vi.total_amount - COALESCE(
        (SELECT SUM(vpa.applied_amount + vpa.discount_taken)
         FROM vendor_payment_applications vpa
         WHERE vpa.vendor_invoice_id = vi.id AND vpa.tenant_id = vi.tenant_id),
        0
      )) AS amount_due
    FROM vendor_invoices vi
    JOIN vendors v ON v.id = vi.vendor_id
    LEFT JOIN purchase_orders po ON po.id = vi.purchase_order_id
    WHERE vi.tenant_id = $1
  `;
  const params: any[] = [tenantId];
  let paramCount = 1;

  if (filters?.status) {
    paramCount++;
    sql += ` AND vi.status = $${paramCount}`;
    params.push(filters.status);
  }

  if (filters?.vendorId) {
    paramCount++;
    sql += ` AND vi.vendor_id = $${paramCount}`;
    params.push(filters.vendorId);
  }

  if (filters?.startDate) {
    paramCount++;
    sql += ` AND vi.invoice_date >= $${paramCount}`;
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    paramCount++;
    sql += ` AND vi.invoice_date <= $${paramCount}`;
    params.push(filters.endDate);
  }

  sql += ` ORDER BY vi.invoice_date DESC, vi.invoice_number DESC`;

  if (filters?.limit) {
    paramCount++;
    sql += ` LIMIT $${paramCount}`;
    params.push(filters.limit);
  }

  const { rows } = await query(sql, params);
  return rows;
}

export async function getVendorInvoice(tenantId: string, invoiceId: string) {
  const { rows: invoiceRows } = await query(
    `SELECT 
      vi.*,
      v.code AS vendor_code,
      v.name AS vendor_name,
      v.email AS vendor_email,
      v.phone AS vendor_phone,
      po.po_number,
      pt.code AS payment_term_code,
      pt.name AS payment_term_name,
      (
        SELECT COALESCE(SUM(vpa.applied_amount + vpa.discount_taken), 0)
        FROM vendor_payment_applications vpa
        WHERE vpa.vendor_invoice_id = vi.id AND vpa.tenant_id = vi.tenant_id
      ) AS amount_paid,
      (vi.total_amount - COALESCE(
        (SELECT SUM(vpa.applied_amount + vpa.discount_taken)
         FROM vendor_payment_applications vpa
         WHERE vpa.vendor_invoice_id = vi.id AND vpa.tenant_id = vi.tenant_id),
        0
      )) AS amount_due
    FROM vendor_invoices vi
    JOIN vendors v ON v.id = vi.vendor_id
    LEFT JOIN purchase_orders po ON po.id = vi.purchase_order_id
    LEFT JOIN vendor_payment_terms pt ON pt.id = vi.payment_term_id
    WHERE vi.tenant_id = $1 AND vi.id = $2`,
    [tenantId, invoiceId]
  );

  if (invoiceRows.length === 0) {
    return null;
  }

  const invoice = invoiceRows[0];

  // Get invoice lines
  const { rows: lineRows } = await query(
    `SELECT 
      vil.*,
      i.sku AS item_sku,
      i.name AS item_name,
      pol.line_number AS po_line_number,
      pol.unit_price AS po_unit_price,
      prl.unit_cost AS receipt_unit_cost
    FROM vendor_invoice_lines vil
    LEFT JOIN items i ON i.id = vil.item_id
    LEFT JOIN purchase_order_lines pol ON pol.id = vil.purchase_order_line_id
    LEFT JOIN purchase_order_receipt_lines prl ON prl.id = vil.receipt_line_id
    WHERE vil.tenant_id = $1 AND vil.vendor_invoice_id = $2
    ORDER BY vil.line_number`,
    [tenantId, invoiceId]
  );

  invoice.lines = lineRows;

  // Get payment applications
  const { rows: paymentRows } = await query(
    `SELECT 
      vpa.*,
      vp.payment_number,
      vp.payment_date,
      vp.payment_method
    FROM vendor_payment_applications vpa
    JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
    WHERE vpa.tenant_id = $1 AND vpa.vendor_invoice_id = $2
    ORDER BY vp.payment_date DESC`,
    [tenantId, invoiceId]
  );

  invoice.payments = paymentRows;

  return invoice;
}

export async function updateVendorInvoice(
  tenantId: string,
  invoiceId: string,
  data: VendorInvoiceUpdateInput,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    // Check if invoice is in draft status
    const { rows: statusRows } = await client.query(
      `SELECT status FROM vendor_invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantId, invoiceId]
    );

    if (statusRows.length === 0) {
      throw new Error('Invoice not found');
    }

    if (statusRows[0].status !== 'draft') {
      throw new Error('Can only update draft invoices');
    }

    // Build update query
    const updates: string[] = [];
    const params: any[] = [tenantId, invoiceId];
    let paramCount = 2;

    if (data.invoiceDate !== undefined) {
      paramCount++;
      updates.push(`invoice_date = $${paramCount}`);
      params.push(data.invoiceDate);
    }

    if (data.dueDate !== undefined) {
      paramCount++;
      updates.push(`due_date = $${paramCount}`);
      params.push(data.dueDate);
    }

    if (data.glDate !== undefined) {
      paramCount++;
      updates.push(`gl_date = $${paramCount}`);
      params.push(data.glDate);
    }

    if (data.paymentTermId !== undefined) {
      paramCount++;
      updates.push(`payment_term_id = $${paramCount}`);
      params.push(data.paymentTermId);
    }

    if (data.vendorInvoiceNumber !== undefined) {
      paramCount++;
      updates.push(`vendor_invoice_number = $${paramCount}`);
      params.push(data.vendorInvoiceNumber);
    }

    if (data.notes !== undefined) {
      paramCount++;
      updates.push(`notes = $${paramCount}`);
      params.push(data.notes);
    }

    // Recalculate totals if amounts change
    if (data.subtotal !== undefined || data.taxAmount !== undefined ||
        data.freightAmount !== undefined || data.discountAmount !== undefined) {
      
      const { rows: currentRows } = await client.query(
        `SELECT subtotal, tax_amount, freight_amount, discount_amount
         FROM vendor_invoices
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, invoiceId]
      );

      const current = currentRows[0];
      const subtotal = data.subtotal ?? current.subtotal;
      const taxAmount = data.taxAmount ?? current.tax_amount;
      const freightAmount = data.freightAmount ?? current.freight_amount;
      const discountAmount = data.discountAmount ?? current.discount_amount;
      const totalAmount = subtotal + taxAmount + freightAmount - discountAmount;

      if (data.subtotal !== undefined) {
        paramCount++;
        updates.push(`subtotal = $${paramCount}`);
        params.push(subtotal);
      }

      if (data.taxAmount !== undefined) {
        paramCount++;
        updates.push(`tax_amount = $${paramCount}`);
        params.push(taxAmount);
      }

      if (data.freightAmount !== undefined) {
        paramCount++;
        updates.push(`freight_amount = $${paramCount}`);
        params.push(freightAmount);
      }

      if (data.discountAmount !== undefined) {
        paramCount++;
        updates.push(`discount_amount = $${paramCount}`);
        params.push(discountAmount);
      }

      paramCount++;
      updates.push(`total_amount = $${paramCount}`);
      params.push(totalAmount);
    }

    paramCount++;
    updates.push(`updated_at = $${paramCount}`);
    params.push(now);

    if (updates.length === 0) {
      return statusRows[0];
    }

    const { rows } = await client.query(
      `UPDATE vendor_invoices
       SET ${updates.join(', ')}
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      params
    );

    // Audit log
    await recordAuditLog({
      tenantId,
      actorType: actor?.type ?? 'system',
      actorId: actor?.id,
      action: 'update',
      entityType: 'vendor_invoice',
      entityId: invoiceId
    }, client);

    return rows[0];
  });
}

export async function approveVendorInvoice(
  tenantId: string,
  invoiceId: string,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    const { rows } = await client.query(
      `UPDATE vendor_invoices
       SET status = 'approved',
           approved_at = $3,
           approved_by_user_id = $4,
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status IN ('draft', 'pending_approval')
       RETURNING *`,
      [tenantId, invoiceId, now, actor?.type === 'user' ? actor.id : null]
    );

    if (rows.length === 0) {
      throw new Error('Invoice not found or cannot be approved');
    }

    // Audit log
    await recordAuditLog({
      tenantId,
      actorType: actor?.type ?? 'system',
      actorId: actor?.id,
      action: 'update',
      entityType: 'vendor_invoice',
      entityId: invoiceId,
      metadata: { status: 'approved' }
    }, client);

    return rows[0];
  });
}

export async function voidVendorInvoice(
  tenantId: string,
  invoiceId: string,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    // Check if invoice has payments
    const { rows: paymentRows } = await client.query(
      `SELECT COUNT(*) as payment_count
       FROM vendor_payment_applications
       WHERE tenant_id = $1 AND vendor_invoice_id = $2`,
      [tenantId, invoiceId]
    );

    if (parseInt(paymentRows[0].payment_count) > 0) {
      throw new Error('Cannot void invoice with payments applied');
    }

    const { rows } = await client.query(
      `UPDATE vendor_invoices
       SET status = 'void',
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status != 'void'
       RETURNING *`,
      [tenantId, invoiceId, now]
    );

    if (rows.length === 0) {
      throw new Error('Invoice not found or already void');
    }

    // Audit log
    await recordAuditLog({
      tenantId,
      actorType: actor?.type ?? 'system',
      actorId: actor?.id,
      action: 'update',
      entityType: 'vendor_invoice',
      entityId: invoiceId,
      metadata: { status: 'void' }
    }, client);

    return rows[0];
  });
}
