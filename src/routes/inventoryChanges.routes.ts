import { Router, type Request, type Response } from 'express';
import { inventoryChangesQuerySchema } from '../schemas/inventoryChanges.schema';
import { getInventoryChanges } from '../services/inventoryChanges.service';

const router = Router();

router.get('/inventory/changes', async (req: Request, res: Response) => {
  const parsed = inventoryChangesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const since = parsed.data.since ?? '0';
  const limit = parsed.data.limit ?? 200;

  try {
    const result = await getInventoryChanges(tenantId, { since, limit });
    return res.json({
      events: result.events,
      nextSeq: result.nextSeq,
      ...(result.resetRequired ? { resetRequired: true } : {})
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load inventory changes.' });
  }
});

export default router;
