import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createVendorPayment,
  listVendorPayments,
  getVendorPayment,
  updateVendorPayment,
  postVendorPayment,
  voidVendorPayment,
  getUnpaidInvoicesForVendor,
} from '../services/vendorPayments.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

const paymentApplicationSchema = z.object({
  vendorInvoiceId: z.string().uuid(),
  appliedAmount: z.number().positive(),
  discountTaken: z.number().nonnegative().optional(),
});

const vendorPaymentSchema = z.object({
  paymentNumber: z.string().max(64).optional(),
  vendorId: z.string().uuid(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(['check', 'ach', 'wire', 'credit_card', 'cash', 'other']),
  referenceNumber: z.string().max(64).optional(),
  paymentAmount: z.number().positive(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
  applications: z.array(paymentApplicationSchema).min(1),
});

const vendorPaymentUpdateSchema = z.object({
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMethod: z.enum(['check', 'ach', 'wire', 'credit_card', 'cash', 'other']).optional(),
  referenceNumber: z.string().max(64).optional(),
  notes: z.string().max(2000).optional(),
});

// Create vendor payment
router.post('/vendor-payments', async (req: Request, res: Response) => {
  const parsed = vendorPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const payment = await createVendorPayment(
      req.auth!.tenantId,
      parsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.payment.created', {
      paymentId: payment.id,
      vendorId: payment.vendor_id,
      paymentAmount: payment.payment_amount,
    });
    return res.status(201).json(payment);
  } catch (error: any) {
    if (error.message === 'Payment amount must equal total applied amount plus discounts') {
      return res.status(400).json({ error: error.message });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Payment number must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Invalid vendor or invoice reference.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create payment.' });
  }
});

// List vendor payments
router.get('/vendor-payments', async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const vendorId = req.query.vendorId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const limitStr = req.query.limit as string | undefined;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  try {
    const payments = await listVendorPayments(req.auth!.tenantId, {
      status,
      vendorId,
      startDate,
      endDate,
      limit,
    });
    return res.json({ data: payments });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list payments.' });
  }
});

// Get vendor payment detail
router.get('/vendor-payments/:id', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid payment ID format.' });
  }

  try {
    const payment = await getVendorPayment(req.auth!.tenantId, idParsed.data);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    return res.json(payment);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to get payment.' });
  }
});

// Update vendor payment
router.put('/vendor-payments/:id', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid payment ID format.' });
  }

  const parsed = vendorPaymentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const payment = await updateVendorPayment(
      req.auth!.tenantId,
      idParsed.data,
      parsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.payment.updated', {
      paymentId: payment.id,
    });
    return res.json(payment);
  } catch (error: any) {
    if (error.message === 'Payment not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Can only update draft payments') {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update payment.' });
  }
});

// Post vendor payment
router.post('/vendor-payments/:id/post', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid payment ID format.' });
  }

  try {
    const payment = await postVendorPayment(
      req.auth!.tenantId,
      idParsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.payment.posted', {
      paymentId: payment.id,
      vendorId: payment.vendor_id,
      paymentAmount: payment.payment_amount,
    });
    return res.json(payment);
  } catch (error: any) {
    if (error.message === 'Payment not found or already posted') {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post payment.' });
  }
});

// Void vendor payment
router.post('/vendor-payments/:id/void', async (req: Request, res: Response) => {
  const idParsed = uuidSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid payment ID format.' });
  }

  try {
    const payment = await voidVendorPayment(
      req.auth!.tenantId,
      idParsed.data,
      { type: 'user', id: req.auth!.userId }
    );
    emitEvent(req.auth!.tenantId, 'ap.payment.voided', {
      paymentId: payment.id,
    });
    return res.json(payment);
  } catch (error: any) {
    if (error.message === 'Payment not found' || error.message === 'Payment already void') {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to void payment.' });
  }
});

// Get unpaid invoices for vendor
router.get('/vendors/:vendorId/unpaid-invoices', async (req: Request, res: Response) => {
  const vendorIdParsed = uuidSchema.safeParse(req.params.vendorId);
  if (!vendorIdParsed.success) {
    return res.status(400).json({ error: 'Invalid vendor ID format.' });
  }

  try {
    const invoices = await getUnpaidInvoicesForVendor(
      req.auth!.tenantId,
      vendorIdParsed.data
    );
    return res.json({ data: invoices });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to get unpaid invoices.' });
  }
});

export default router;
