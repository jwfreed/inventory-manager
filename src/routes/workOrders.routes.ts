import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  workOrderCreateSchema,
  workOrderDefaultLocationsSchema,
  workOrderListQuerySchema,
  workOrderRequirementsQuerySchema,
  workOrderUpdateSchema
} from '../schemas/workOrders.schema';
import {
  createWorkOrder,
  getWorkOrderById,
  getWorkOrderRequirements,
  listWorkOrders,
  updateWorkOrderDefaults,
  updateWorkOrderDescription,
  useActiveBomVersion
} from '../services/workOrders.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/work-orders', async (req: Request, res: Response) => {
  const parsed = workOrderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const workOrder = await createWorkOrder(req.auth!.tenantId, parsed.data);
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
      unique: () => ({ status: 409, body: { error: 'Work order number must be unique.' } }),
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

router.patch('/work-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const updated = await updateWorkOrderDescription(req.auth!.tenantId, id, parsed.data.description ?? null);
    if (!updated) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(updated);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to update work order.' });
  }
});

router.get('/work-orders/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }

  try {
    const workOrder = await getWorkOrderById(req.auth!.tenantId, id);
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
    const result = await listWorkOrders(req.auth!.tenantId, parsed.data);
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list work orders.' });
  }
});

router.get('/work-orders/:id/requirements', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderRequirementsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const quantity = parsed.data.quantity ? Number(parsed.data.quantity) : undefined;
  const packSize = parsed.data.packSize ? Number(parsed.data.packSize) : undefined;
  if (quantity !== undefined && !(quantity > 0)) {
    return res.status(400).json({ error: 'Quantity must be positive if provided.' });
  }
  if (packSize !== undefined && !(packSize > 0)) {
    return res.status(400).json({ error: 'packSize must be positive if provided.' });
  }

  try {
    const requirements = await getWorkOrderRequirements(req.auth!.tenantId, id, quantity, packSize);
    if (!requirements) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(requirements);
  } catch (error: any) {
    if (error?.message === 'WO_BOM_NOT_FOUND') {
      return res.status(400).json({ error: 'BOM not found for this work order.' });
    }
    if (error?.message === 'WO_BOM_VERSION_NOT_FOUND') {
      return res.status(400).json({ error: 'No BOM version available for this work order.' });
    }
    if (error?.message === 'WO_BOM_LEGACY_UNSUPPORTED') {
      return res.status(409).json({ error: 'Legacy BOM detected; requirements cannot be planned.' });
    }
    if (error?.message === 'WO_REQUIREMENTS_UOM_MISMATCH') {
      return res.status(400).json({ error: 'Output UOM does not match BOM yield UOM.' });
    }
    if (error?.message === 'WO_REQUIREMENTS_INVALID_YIELD') {
      return res.status(400).json({ error: 'Invalid BOM yield quantity.' });
    }
    if (error?.message?.startsWith('ITEM_CANONICAL_UOM') || error?.message?.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute work order requirements.' });
  }
});

router.patch('/work-orders/:id/default-locations', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }
  const parsed = workOrderDefaultLocationsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const updated = await updateWorkOrderDefaults(req.auth!.tenantId, id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(updated);
  } catch (error) {
    if ((error as Error)?.message === 'WO_DEFAULT_CONSUME_LOCATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Default consume location not found.' });
    }
    if ((error as Error)?.message === 'WO_DEFAULT_PRODUCE_LOCATION_NOT_FOUND') {
      return res.status(404).json({ error: 'Default produce location not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update default locations.' });
  }
});

router.post('/work-orders/:id/use-active-bom', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid work order id.' });
  }

  try {
    const updated = await useActiveBomVersion(req.auth!.tenantId, id, {
      type: 'user',
      id: req.auth!.userId
    });
    if (!updated) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    return res.json(updated);
  } catch (error: any) {
    if (error?.message === 'WO_NOT_FOUND') {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    if (error?.message === 'WO_BOM_NOT_FOUND') {
      return res.status(400).json({ error: 'Work order has no BOM to switch.' });
    }
    if (error?.message === 'WO_BOM_VERSION_NOT_FOUND') {
      return res.status(400).json({ error: 'No active BOM version found.' });
    }
    if (error?.message === 'WO_BOM_UNSUPPORTED') {
      return res.status(400).json({ error: 'Disassembly work orders do not use BOM versions.' });
    }
    if (error?.message === 'WO_BOM_UOM_MISMATCH') {
      return res.status(409).json({ error: 'Active BOM yield UOM does not match the work order output UOM.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to switch work order BOM version.' });
  }
});

export default router;
