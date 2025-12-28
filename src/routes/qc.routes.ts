import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { qcEventSchema } from '../schemas/qc.schema';
import { createQcEvent, getQcEventById, listQcEventsForLine } from '../services/qc.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/qc-events', async (req: Request, res: Response) => {
  const parsed = qcEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const event = await createQcEvent(req.auth!.tenantId, parsed.data);
    return res.status(201).json(event);
  } catch (error: any) {
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    if (error?.message === 'QC_RECEIPT_VOIDED') {
      return res.status(409).json({ error: 'Receipt is voided; QC events are not allowed.' });
    }
    if (error?.message === 'QC_UOM_MISMATCH') {
      return res.status(400).json({ error: 'QC event UOM must match the receipt line UOM.' });
    }
    if (error?.message === 'QC_EXCEEDS_RECEIPT') {
      return res.status(400).json({ error: 'QC quantities cannot exceed the received quantity for the line.' });
    }
    if (error?.message === 'QC_ACCEPT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Receipt line has no receiving location to post accepted inventory.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({ status: 400, body: { error: 'Referenced receipt line does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'QC quantity must be greater than zero.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
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
    const events = await listQcEventsForLine(req.auth!.tenantId, id);
    return res.json({ data: events });
  } catch (error: any) {
    if (error?.message === 'QC_LINE_NOT_FOUND') {
      return res.status(404).json({ error: 'Receipt line not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to list QC events.' });
  }
});

router.get('/qc-events/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid QC event id.' });
  }

  try {
    const event = await getQcEventById(req.auth!.tenantId, id);
    if (!event) {
      return res.status(404).json({ error: 'QC event not found.' });
    }
    return res.json(event);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch QC event.' });
  }
});

export default router;
