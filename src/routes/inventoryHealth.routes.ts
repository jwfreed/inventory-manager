import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { computeInventoryHealth } from '../domains/inventory/health.service';

const router = Router();

const querySchema = z.object({
  topLimit: z.coerce.number().int().min(1).max(200).optional(),
  countWindowDays: z.coerce.number().int().min(1).max(365).optional()
});

router.get('/admin/inventory-health', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const data = await computeInventoryHealth(req.auth!.tenantId, parsed.data);
    const status = data.gate.pass ? 200 : 409;
    return res.status(status).json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory health.' });
  }
});

export default router;
