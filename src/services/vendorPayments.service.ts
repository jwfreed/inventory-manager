import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction, PoolClient } from '../db';
import { recordAuditLog } from './audit.service';

export interface VendorPaymentInput {
  paymentNumber?: string;
  vendorId: string;
  paymentDate: string;
  paymentMethod: 'check' | 'ach' | 'wire' | 'credit_card' | 'cash' | 'other';
  referenceNumber?: string;
  paymentAmount: number;
  currency?: string;
  exchangeRate?: number;
  notes?: string;
  applications: PaymentApplicationInput[];
}

export interface PaymentApplicationInput {
  vendorInvoiceId: string;
  appliedAmount: number;
  discountTaken?: number;
}

export interface VendorPaymentUpdateInput {
  paymentDate?: string;
  paymentMethod?: 'check' | 'ach' | 'wire' | 'credit_card' | 'cash' | 'other';
  referenceNumber?: string;
  notes?: string;
}

export async function createVendorPayment(
  tenantId: string,
  data: VendorPaymentInput,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const paymentId = uuidv4();
    const now = new Date();

    // Generate payment number if not provided
    let paymentNumber = data.paymentNumber;
    if (!paymentNumber) {
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(payment_number FROM '^PAY-([0-9]+)$') AS INTEGER)), 0) + 1 AS next_num
         FROM vendor_payments
         WHERE tenant_id = $1 AND payment_number ~ '^PAY-[0-9]+$'`,
        [tenantId]
      );
      paymentNumber = `PAY-${String(seqRows[0].next_num).padStart(6, '0')}`;
    }

    // Validate payment amount matches applications
    const totalApplied = data.applications.reduce(
      (sum, app) => sum + app.appliedAmount + (app.discountTaken ?? 0),
      0
    );

    if (Math.abs(data.paymentAmount - totalApplied) > 0.01) {
      throw new Error('Payment amount must equal total applied amount plus discounts');
    }

    // Insert payment
    const { rows: paymentRows } = await client.query(
      `INSERT INTO vendor_payments (
        id, tenant_id, payment_number, vendor_id,
        payment_date, payment_method, reference_number,
        payment_amount, currency, exchange_rate, status, notes,
        created_at, updated_at, created_by_user_id
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $13, $14
      ) RETURNING *`,
      [
        paymentId,
        tenantId,
        paymentNumber,
        data.vendorId,
        data.paymentDate,
        data.paymentMethod,
        data.referenceNumber ?? null,
        data.paymentAmount,
        data.currency ?? 'USD',
        data.exchangeRate ?? 1.0,
        'draft',
        data.notes ?? null,
        now,
        actor?.type === 'user' ? actor.id : null,
      ]
    );

    // Insert payment applications
    for (const app of data.applications) {
      const appId = uuidv4();

      await client.query(
        `INSERT INTO vendor_payment_applications (
          id, tenant_id, vendor_payment_id, vendor_invoice_id,
          applied_amount, discount_taken, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )`,
        [
          appId,
          tenantId,
          paymentId,
          app.vendorInvoiceId,
          app.appliedAmount,
          app.discountTaken ?? 0,
          now,
        ]
      );

      // Update invoice status
      await updateInvoicePaymentStatus(tenantId, app.vendorInvoiceId, client);
    }

    // Audit log
    await recordAuditLog(
      tenantId,
      'vendor_payment',
      paymentId,
      'created',
      null,
      actor,
      client
    );

    return paymentRows[0];
  });
}

async function updateInvoicePaymentStatus(
  tenantId: string,
  invoiceId: string,
  client: PoolClient
) {
  // Calculate total paid vs total amount
  const { rows } = await client.query(
    `SELECT 
      vi.total_amount,
      COALESCE(SUM(vpa.applied_amount + vpa.discount_taken), 0) AS amount_paid
    FROM vendor_invoices vi
    LEFT JOIN vendor_payment_applications vpa ON vpa.vendor_invoice_id = vi.id AND vpa.tenant_id = vi.tenant_id
    WHERE vi.tenant_id = $1 AND vi.id = $2
    GROUP BY vi.id, vi.total_amount`,
    [tenantId, invoiceId]
  );

  if (rows.length === 0) {
    return;
  }

  const { total_amount, amount_paid } = rows[0];
  const amountDue = parseFloat(total_amount) - parseFloat(amount_paid);

  let newStatus: string;
  if (amountDue <= 0.01) {
    newStatus = 'paid';
  } else if (parseFloat(amount_paid) > 0) {
    newStatus = 'partially_paid';
  } else {
    newStatus = 'approved'; // No payment yet
  }

  await client.query(
    `UPDATE vendor_invoices
     SET status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND status IN ('approved', 'partially_paid', 'paid')`,
    [tenantId, invoiceId, newStatus]
  );
}

export async function listVendorPayments(tenantId: string, filters?: {
  status?: string;
  vendorId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}) {
  let sql = `
    SELECT 
      vp.*,
      v.code AS vendor_code,
      v.name AS vendor_name,
      (
        SELECT COUNT(*)
        FROM vendor_payment_applications vpa
        WHERE vpa.vendor_payment_id = vp.id AND vpa.tenant_id = vp.tenant_id
      ) AS invoice_count
    FROM vendor_payments vp
    JOIN vendors v ON v.id = vp.vendor_id
    WHERE vp.tenant_id = $1
  `;
  const params: any[] = [tenantId];
  let paramCount = 1;

  if (filters?.status) {
    paramCount++;
    sql += ` AND vp.status = $${paramCount}`;
    params.push(filters.status);
  }

  if (filters?.vendorId) {
    paramCount++;
    sql += ` AND vp.vendor_id = $${paramCount}`;
    params.push(filters.vendorId);
  }

  if (filters?.startDate) {
    paramCount++;
    sql += ` AND vp.payment_date >= $${paramCount}`;
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    paramCount++;
    sql += ` AND vp.payment_date <= $${paramCount}`;
    params.push(filters.endDate);
  }

  sql += ` ORDER BY vp.payment_date DESC, vp.payment_number DESC`;

  if (filters?.limit) {
    paramCount++;
    sql += ` LIMIT $${paramCount}`;
    params.push(filters.limit);
  }

  const { rows } = await query(sql, params);
  return rows;
}

export async function getVendorPayment(tenantId: string, paymentId: string) {
  const { rows: paymentRows } = await query(
    `SELECT 
      vp.*,
      v.code AS vendor_code,
      v.name AS vendor_name,
      v.email AS vendor_email,
      v.phone AS vendor_phone
    FROM vendor_payments vp
    JOIN vendors v ON v.id = vp.vendor_id
    WHERE vp.tenant_id = $1 AND vp.id = $2`,
    [tenantId, paymentId]
  );

  if (paymentRows.length === 0) {
    return null;
  }

  const payment = paymentRows[0];

  // Get payment applications with invoice details
  const { rows: appRows } = await query(
    `SELECT 
      vpa.*,
      vi.invoice_number,
      vi.vendor_invoice_number,
      vi.invoice_date,
      vi.due_date,
      vi.total_amount AS invoice_total,
      (vi.total_amount - COALESCE(
        (SELECT SUM(vpa2.applied_amount + vpa2.discount_taken)
         FROM vendor_payment_applications vpa2
         WHERE vpa2.vendor_invoice_id = vi.id AND vpa2.tenant_id = vi.tenant_id),
        0
      )) AS invoice_amount_due
    FROM vendor_payment_applications vpa
    JOIN vendor_invoices vi ON vi.id = vpa.vendor_invoice_id
    WHERE vpa.tenant_id = $1 AND vpa.vendor_payment_id = $2
    ORDER BY vi.invoice_number`,
    [tenantId, paymentId]
  );

  payment.applications = appRows;

  return payment;
}

export async function updateVendorPayment(
  tenantId: string,
  paymentId: string,
  data: VendorPaymentUpdateInput,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    // Check if payment is in draft status
    const { rows: statusRows } = await client.query(
      `SELECT status FROM vendor_payments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, paymentId]
    );

    if (statusRows.length === 0) {
      throw new Error('Payment not found');
    }

    if (statusRows[0].status !== 'draft') {
      throw new Error('Can only update draft payments');
    }

    // Build update query
    const updates: string[] = [];
    const params: any[] = [tenantId, paymentId];
    let paramCount = 2;

    if (data.paymentDate !== undefined) {
      paramCount++;
      updates.push(`payment_date = $${paramCount}`);
      params.push(data.paymentDate);
    }

    if (data.paymentMethod !== undefined) {
      paramCount++;
      updates.push(`payment_method = $${paramCount}`);
      params.push(data.paymentMethod);
    }

    if (data.referenceNumber !== undefined) {
      paramCount++;
      updates.push(`reference_number = $${paramCount}`);
      params.push(data.referenceNumber);
    }

    if (data.notes !== undefined) {
      paramCount++;
      updates.push(`notes = $${paramCount}`);
      params.push(data.notes);
    }

    paramCount++;
    updates.push(`updated_at = $${paramCount}`);
    params.push(now);

    if (updates.length === 0) {
      return statusRows[0];
    }

    const { rows } = await client.query(
      `UPDATE vendor_payments
       SET ${updates.join(', ')}
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      params
    );

    // Audit log
    await recordAuditLog(
      tenantId,
      'vendor_payment',
      paymentId,
      'updated',
      null,
      actor,
      client
    );

    return rows[0];
  });
}

export async function postVendorPayment(
  tenantId: string,
  paymentId: string,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    const { rows } = await client.query(
      `UPDATE vendor_payments
       SET status = 'posted',
           posted_at = $3,
           posted_by_user_id = $4,
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
       RETURNING *`,
      [tenantId, paymentId, now, actor?.type === 'user' ? actor.id : null]
    );

    if (rows.length === 0) {
      throw new Error('Payment not found or already posted');
    }

    // Audit log
    await recordAuditLog(
      tenantId,
      'vendor_payment',
      paymentId,
      'posted',
      null,
      actor,
      client
    );

    return rows[0];
  });
}

export async function voidVendorPayment(
  tenantId: string,
  paymentId: string,
  actor?: { type: 'user' | 'system'; id?: string }
) {
  return withTransaction(async (client: PoolClient) => {
    const now = new Date();

    // Check current status
    const { rows: statusRows } = await client.query(
      `SELECT status FROM vendor_payments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, paymentId]
    );

    if (statusRows.length === 0) {
      throw new Error('Payment not found');
    }

    if (statusRows[0].status === 'void') {
      throw new Error('Payment already void');
    }

    // Void the payment
    const { rows } = await client.query(
      `UPDATE vendor_payments
       SET status = 'void',
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, paymentId, now]
    );

    // Update invoice statuses for all applications
    const { rows: appRows } = await client.query(
      `SELECT vendor_invoice_id
       FROM vendor_payment_applications
       WHERE tenant_id = $1 AND vendor_payment_id = $2`,
      [tenantId, paymentId]
    );

    for (const app of appRows) {
      await updateInvoicePaymentStatus(tenantId, app.vendor_invoice_id, client);
    }

    // Audit log
    await recordAuditLog(
      tenantId,
      'vendor_payment',
      paymentId,
      'voided',
      null,
      actor,
      client
    );

    return rows[0];
  });
}

export async function getUnpaidInvoicesForVendor(
  tenantId: string,
  vendorId: string
) {
  const { rows } = await query(
    `SELECT 
      vi.id,
      vi.invoice_number,
      vi.vendor_invoice_number,
      vi.invoice_date,
      vi.due_date,
      vi.total_amount,
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
    WHERE vi.tenant_id = $1 
      AND vi.vendor_id = $2
      AND vi.status IN ('approved', 'partially_paid')
    ORDER BY vi.due_date, vi.invoice_date`,
    [tenantId, vendorId]
  );

  return rows.filter(row => parseFloat(row.amount_due) > 0.01);
}
