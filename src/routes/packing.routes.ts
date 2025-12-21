import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { packLineSchema, packSchema } from '../schemas/packing.schema';
import {
  addPackLine,
  createPack,
  deletePackLine,
  getPack,
  listPacks,
  mapPackError,
} from '../services/packing.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/packs', async (req: Request, res: Response) => {
  const parsed = packSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const pack = await createPack(req.auth!.tenantId, parsed.data);
    return res.status(201).json(pack);
  } catch (error: any) {
    const mapped = mapPackError(error);
    if (mapped?.http) return res.status(mapped.http.status).json(mapped.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create pack.' });
  }
});

router.get('/packs', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listPacks(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/packs/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid pack id.' });
  }
  const pack = await getPack(req.auth!.tenantId, id);
  if (!pack) return res.status(404).json({ error: 'Pack not found.' });
  return res.json(pack);
});

router.post('/packs/:id/lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid pack id.' });
  }
  const parsed = packLineSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const line = await addPackLine(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json(line);
  } catch (error: any) {
    const mapped = mapPackError(error);
    if (mapped?.http) return res.status(mapped.http.status).json(mapped.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to add pack line.' });
  }
});

router.delete('/packs/:id/lines/:lineId', async (req: Request, res: Response) => {
  const { id, lineId } = req.params;
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(lineId).success) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  const deleted = await deletePackLine(req.auth!.tenantId, id, lineId);
  if (!deleted) return res.status(404).json({ error: 'Pack line not found.' });
  return res.status(204).send();
});

export default router;
