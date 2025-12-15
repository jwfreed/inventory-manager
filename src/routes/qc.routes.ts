import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { qcEventSchema } from '../schemas/qc.schema';
import { createQcEvent, listQcEventsForLine } from '../services/qc.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/qc-events', async (req: Request, res: Response) => {
  const parsed = qcEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const event = await createQcEvent(parsed.data);
    return res.status(201).json(event);
  } catch (error: any) {
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    if (error?.message === 'QC_UOM_MISMATCH') {
      return res.status(400).json({ error: 'QC event UOM must match the receipt line UOM.' });
    }
    if (error?.message === 'QC_EXCEEDS_RECEIPT') {
      return res.status(400).json({ error: 'QC quantities cannot exceed the received quantity for the line.' });
    }
    if (error?.code === '23503') {
      return res.status(400).json({ error: 'Referenced receipt line does not exist.' });
    }
    if (error?.code === '23514') {
      return res.status(400).json({ error: 'QC quantity must be greater than zero.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create QC event.' });
  }
});

router.get('/purchase-order-receipt-lines/:id/qc-events', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid receipt line id.' });
  }

  try {
    const events = await listQcEventsForLine(id);
    return res.json({ data: events });
  } catch (error: any) {
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
  }
});

export default router;
