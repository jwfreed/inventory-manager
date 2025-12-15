import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { purchaseOrderReceiptSchema } from '../schemas/receipts.schema';
import { createPurchaseOrderReceipt, fetchReceiptById } from '../services/receipts.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/purchase-order-receipts', async (req: Request, res: Response) => {
  const parsed = purchaseOrderReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const receipt = await createPurchaseOrderReceipt(parsed.data);
    return res.status(201).json(receipt);
  } catch (error: any) {
    if (error?.message === 'RECEIPT_PO_LINES_NOT_FOUND') {
      return res.status(400).json({ error: 'One or more purchase order lines were not found.' });
    }
    if (error?.message === 'RECEIPT_LINE_INVALID_REFERENCE') {
      return res.status(400).json({ error: 'Invalid purchase order line reference.' });
    }
    if (error?.message === 'RECEIPT_LINES_WRONG_PO') {
      return res
        .status(400)
        .json({ error: 'All receipt lines must reference the provided purchase order.' });
    }
    if (error?.message === 'RECEIPT_LINE_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Receipt line UOM must match the purchase order line UOM.' });
    }
    if (error?.message === 'RECEIPT_NOT_FOUND_AFTER_CREATE') {
      return res
        .status(500)
        .json({ error: 'Receipt was created but could not be reloaded. Please retry fetch.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Referenced purchase order, line, or location does not exist.' }
      }),
      check: () => ({ status: 400, body: { error: 'Quantity received must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order receipt.' });
  }
});

router.get('/purchase-order-receipts/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt id.' });
  }
  try {
    const receipt = await fetchReceiptById(id);
    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    return res.json(receipt);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch receipt.' });
  }
});

export default router;
