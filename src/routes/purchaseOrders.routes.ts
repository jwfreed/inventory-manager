import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createPurchaseOrder, getPurchaseOrderById, listPurchaseOrders } from '../services/purchaseOrders.service';
import { purchaseOrderSchema } from '../schemas/purchaseOrders.schema';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/purchase-orders', async (req: Request, res: Response) => {
  const parsed = purchaseOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const purchaseOrder = await createPurchaseOrder(parsed.data);
    return res.status(201).json(purchaseOrder);
  } catch (error: any) {
    if (error?.message === 'PO_DUPLICATE_LINE_NUMBERS') {
      return res.status(400).json({ error: 'Line numbers must be unique within a purchase order.' });
    }
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'PO number must be unique.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced vendor, item, or location does not exist.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create purchase order.' });
  }
});

router.get('/purchase-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid purchase order id.' });
  }

  try {
    const po = await getPurchaseOrderById(id);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    return res.json(po);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch purchase order.' });
  }
});

router.get('/purchase-orders', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const rows = await listPurchaseOrders(limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list purchase orders.' });
  }
});

export default router;
