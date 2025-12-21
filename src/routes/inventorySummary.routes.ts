import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { inventorySummaryParamsSchema } from '../schemas/inventorySummary.schema';
import {
  assertItemExists,
  assertLocationExists,
  getItemInventorySummary,
  getLocationInventorySummary
} from '../services/inventorySummary.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/items/:id/inventory', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!inventorySummaryParamsSchema.shape.id.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }

  const tenantId = req.auth!.tenantId;
  const exists = await assertItemExists(tenantId, id);
  if (!exists) {
    return res.status(404).json({ error: 'Item not found.' });
  }

  try {
    const summary = await getItemInventorySummary(tenantId, id);
    return res.json({ data: summary });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory summary.' });
  }
});

router.get('/locations/:id/inventory', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid location id.' });
  }

  const tenantId = req.auth!.tenantId;
  const exists = await assertLocationExists(tenantId, id);
  if (!exists) {
    return res.status(404).json({ error: 'Location not found.' });
  }

  try {
    const summary = await getLocationInventorySummary(tenantId, id);
    return res.json({ data: summary });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory summary.' });
  }
});

export default router;
