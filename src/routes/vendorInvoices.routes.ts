import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createVendorInvoice,
  listVendorInvoices,
  getVendorInvoice,
  updateVendorInvoice,
  approveVendorInvoice,
  voidVendorInvoice,
} from '../services/vendorInvoices.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

const vendorInvoiceLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  purchaseOrderLineId: z.string().uuid().optional(),
  receiptLineId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  description: z.string().min(1).max(500),
  quantity: z.number().positive(),
  uom: z.string().min(1).max(20),
  unitPrice: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().optional(),
  notes: z.string().max(1000).optional(),
});

const vendorInvoiceSchema = z.object({
  invoiceNumber: z.string().max(64).optional(),
  vendorId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  glDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.number().positive().optional(),
  subtotal: z.number().nonnegative(),
  taxAmount: z.number().nonnegative().optional(),
  freightAmount: z.number().nonnegative().optional(),
  discountAmount: z.number().nonnegative().optional(),
  paymentTermId: z.string().uuid().optional(),
  vendorInvoiceNumber: z.string().max(64).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(vendorInvoiceLineSchema).min(1),
});

const vendorInvoiceUpdateSchema = z.object({
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  glDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  subtotal: z.number().nonnegative().optional(),
  taxAmount: z.number().nonnegative().optional(),
  freightAmount: z.number().nonnegative().optional(),
  discountAmount: z.number().nonnegative().optional(),
  paymentTermId: z.string().uuid().optional(),
  vendorInvoiceNumber: z.string().max(64).optional(),
  notes: z.string().max(2000).optional(),
});

// Create vendor invoice
router.post('/vendor-invoices', async (req: Request, res: Response) => {
  const parsed = vendorInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const invoice = await createVendorInvoice(
      req.auth!.tenantId,
      parsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.invoice.created', {
      invoiceId: invoice.id,
      vendorId: invoice.vendor_id,
    });
    return res.status(201).json(invoice);
  } catch (error: any) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Invoice number must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid vendor, purchase order, or payment term reference.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create invoice.' });
  }
});

// List vendor invoices
router.get('/vendor-invoices', async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const vendorId = req.query.vendorId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const limitStr = req.query.limit as string | undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  try {
    const invoices = await listVendorInvoices(req.auth!.tenantId, {
      status,
      vendorId,
      startDate,
      endDate,
      limit,
    });
    return res.json({ data: invoices });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list invoices.' });
  }
});

// Get vendor invoice detail
router.get('/vendor-invoices/:id', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid invoice ID format.' });
  }

  try {
    const invoice = await getVendorInvoice(req.auth!.tenantId, idParsed.data);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    return res.json(invoice);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to get invoice.' });
  }
});

// Update vendor invoice
router.put('/vendor-invoices/:id', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid invoice ID format.' });
  }

  const parsed = vendorInvoiceUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const invoice = await updateVendorInvoice(
      req.auth!.tenantId,
      idParsed.data,
      parsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.invoice.updated', {
      invoiceId: invoice.id,
    });
    return res.json(invoice);
  } catch (error: any) {
    if (error.message === 'Invoice not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Can only update draft invoices') {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update invoice.' });
  }
});

// Approve vendor invoice
router.post('/vendor-invoices/:id/approve', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid invoice ID format.' });
  }

  try {
    const invoice = await approveVendorInvoice(
      req.auth!.tenantId,
      idParsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.invoice.approved', {
      invoiceId: invoice.id,
      vendorId: invoice.vendor_id,
      totalAmount: invoice.total_amount,
    });
    return res.json(invoice);
  } catch (error: any) {
    if (error.message === 'Invoice not found or cannot be approved') {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to approve invoice.' });
  }
});

// Void vendor invoice
router.post('/vendor-invoices/:id/void', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid invoice ID format.' });
  }

  try {
    const invoice = await voidVendorInvoice(
      req.auth!.tenantId,
      idParsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.invoice.voided', {
      invoiceId: invoice.id,
    });
    return res.json(invoice);
  } catch (error: any) {
    if (error.message === 'Cannot void invoice with payments applied') {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === 'Invoice not found or already void') {
      return res.status(404).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to void invoice.' });
  }
});

export default router;
