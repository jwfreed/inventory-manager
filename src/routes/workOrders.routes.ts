import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { workOrderCreateSchema, workOrderListQuerySchema } from '../schemas/workOrders.schema';
import { createWorkOrder, getWorkOrderById, listWorkOrders } from '../services/workOrders.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/work-orders', async (req: Request, res: Response) => {
  const parsed = workOrderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const workOrder = await createWorkOrder(parsed.data);
    return res.status(201).json(workOrder);
  } catch (error: any) {
    if (error?.message === 'WO_BOM_NOT_FOUND') {
      return res.status(400).json({ error: 'BOM not found.' });
    }
    if (error?.message === 'WO_BOM_ITEM_MISMATCH') {
      return res.status(400).json({ error: 'BOM output item must match work order output item.' });
    }
    if (error?.message === 'WO_BOM_VERSION_NOT_FOUND') {
      return res.status(400).json({ error: 'BOM version not found.' });
    }
    if (error?.message === 'WO_BOM_VERSION_MISMATCH') {
      return res.status(400).json({ error: 'BOM version does not belong to the specified BOM.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'workOrderNumber must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Referenced BOM, BOM version, or item does not exist.' } }),
      check: () => ({ status: 400, body: { error: 'Quantity planned must be positive.' } }),
      notNull: () => ({ status: 400, body: { error: 'Missing required fields.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create work order.' });
  }
});

router.get('/work-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }

  try {
    const workOrder = await getWorkOrderById(id);
    if (!workOrder) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(workOrder);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch work order.' });
  }
});

router.get('/work-orders', async (req: Request, res: Response) => {
  const parsed = workOrderListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await listWorkOrders(parsed.data);
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list work orders.' });
  }
});

export default router;
