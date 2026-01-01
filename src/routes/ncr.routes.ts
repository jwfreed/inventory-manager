import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getNcr, updateNcrDisposition, listNcrs, ncrUpdateSchema } from '../services/ncr.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/ncrs', async (req: Request, res: Response) => {
  const status = req.query.status as 'open' | 'closed' | undefined;
  try {
    const ncrs = await listNcrs(req.auth!.tenantId, status);
    return res.json({ data: ncrs });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list NCRs.' });
  }
});

router.get('/ncrs/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid NCR id.' });
  }

  try {
    const ncr = await getNcr(req.auth!.tenantId, id);
    if (!ncr) {
      return res.status(404).json({ error: 'NCR not found.' });
    }
    return res.json(ncr);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch NCR.' });
  }
});

router.patch('/ncrs/:id/disposition', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid NCR id.' });
  }

  const parsed = ncrUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const ncr = await updateNcrDisposition(req.auth!.tenantId, id, parsed.data);
    return res.json(ncr);
  } catch (error: any) {
    if (error?.message === 'NCR_NOT_FOUND') {
      return res.status(404).json({ error: 'NCR not found.' });
    }
    if (error?.message === 'NCR_ALREADY_CLOSED') {
      return res.status(409).json({ error: 'NCR is already closed.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update NCR disposition.' });
  }
});

export default router;
