import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { processOutboxBatch } from '../outbox/processor';

const router = Router();

router.post('/admin/outbox/process', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const schema = z.object({
    limit: z.number().int().min(1).max(200).optional()
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const processed = await processOutboxBatch(parsed.data.limit ?? 50);
    return res.json({ processed });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to process outbox events.' });
  }
});

export default router;
