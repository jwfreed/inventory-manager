import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  closePurchaseOrderReceipt,
  fetchReceiptReconciliation
} from '../services/closeout.service';
import { receiptCloseSchema } from '../schemas/closeout.schema';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/purchase-order-receipts/:id/reconciliation', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const reconciliation = await fetchReceiptReconciliation(req.auth!.tenantId, id);
    if (!reconciliation) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json(reconciliation);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute receipt reconciliation.' });
  }
});

router.post('/purchase-order-receipts/:id/close', async (req: Request, res: Response) => {
  const receiptId = req.params.id;
  if (!uuidSchema.safeParse(receiptId).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  const parsed = receiptCloseSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const reconciliation = await closePurchaseOrderReceipt(req.auth!.tenantId, receiptId, parsed.data);
    return res.json(reconciliation);
  } catch (error: any) {
    if (error?.message === 'RECEIPT_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    if (error?.message === 'RECEIPT_ALREADY_CLOSED') {
      return res.status(409).json({ error: 'Receipt already closed.' });
    }
    if (error?.message === 'RECEIPT_NOT_ELIGIBLE') {
      return res.status(400).json({ error: 'Receipt cannot be closed.', reasons: error.reasons ?? [] });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to close receipt.' });
  }
});

export default router;
