import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pickBatchSchema, pickTaskSchema } from '../schemas/picking.schema';
import {
  createPickBatch,
  createPickTask,
  createWave,
  getPickBatch,
  getPickTask,
  listPickBatches,
  listPickTasks,
} from '../services/picking.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();
const createWaveSchema = z.object({
  salesOrderIds: z.array(z.string().uuid()).min(1),
});

router.post('/waves', async (req: Request, res: Response) => {
  const parsed = createWaveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = await createWave(req.auth!.tenantId, parsed.data.salesOrderIds);
    return res.status(201).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create wave.' });
  }
});

router.post('/pick-batches', async (req: Request, res: Response) => {
  const parsed = pickBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const batch = await createPickBatch(req.auth!.tenantId, parsed.data);
    return res.status(201).json(batch);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      check: () => ({ status: 400, body: { error: 'Invalid status or type.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create pick batch.' });
  }
});

router.get('/pick-batches', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listPickBatches(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/pick-batches/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid pick batch id.' });
  }
  const batch = await getPickBatch(req.auth!.tenantId, id);
  if (!batch) return res.status(404).json({ error: 'Pick batch not found.' });
  return res.json(batch);
});

router.post('/pick-tasks', async (req: Request, res: Response) => {
  const parsed = pickTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const task = await createPickTask(req.auth!.tenantId, parsed.data);
    return res.status(201).json(task);
  } catch (error: any) {
    if (error?.http) return res.status(error.http.status).json(error.http.body);
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Referenced batch, reservation, order line, item, or location not found.' },
      }),
      check: () => ({ status: 400, body: { error: 'Invalid status or quantity.' } }),
    });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create pick task.' });
  }
});

router.get('/pick-tasks', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listPickTasks(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/pick-tasks/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid pick task id.' });
  }
  const task = await getPickTask(req.auth!.tenantId, id);
  if (!task) return res.status(404).json({ error: 'Pick task not found.' });
  return res.json(task);
});

export default router;
