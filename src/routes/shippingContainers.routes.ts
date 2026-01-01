import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { shippingContainerItemSchema, shippingContainerSchema } from '../schemas/shippingContainers.schema';
import {
  addShippingContainerItem,
  createShippingContainer,
  deleteShippingContainerItem,
  getShippingContainer,
  listShippingContainers,
  mapShippingContainerError,
} from '../services/shippingContainers.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/shipping-containers', async (req: Request, res: Response) => {
  const parsed = shippingContainerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const container = await createShippingContainer(req.auth!.tenantId, parsed.data);
    return res.status(201).json(container);
  } catch (error: any) {
    const mapped = mapShippingContainerError(error);
    if (mapped?.http) return res.status(mapped.http.status).json(mapped.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create shipping container.' });
  }
});

router.get('/shipping-containers', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listShippingContainers(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/shipping-containers/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid container id.' });
  }
  const container = await getShippingContainer(req.auth!.tenantId, id);
  if (!container) return res.status(404).json({ error: 'Shipping container not found.' });
  return res.json(container);
});

router.post('/shipping-containers/:id/items', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid container id.' });
  }
  const parsed = shippingContainerItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const item = await addShippingContainerItem(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json(item);
  } catch (error: any) {
    const mapped = mapShippingContainerError(error);
    if (mapped?.http) return res.status(mapped.http.status).json(mapped.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to add shipping container item.' });
  }
});

router.delete('/shipping-containers/:id/items/:itemId', async (req: Request, res: Response) => {
  const { id, itemId } = req.params;
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  const deleted = await deleteShippingContainerItem(req.auth!.tenantId, id, itemId);
  if (!deleted) return res.status(404).json({ error: 'Shipping container item not found.' });
  return res.status(204).send();
});

export default router;
