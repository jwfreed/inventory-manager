import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { itemSchema, locationSchema, uomConversionSchema } from '../schemas/masterData.schema';
import {
  createItem,
  createLocation,
  createStandardWarehouseTemplate,
  createUomConversion,
  deleteUomConversion,
  getItem,
  getLocation,
  listItems,
  listLocations,
  listUomConversionsByItem,
  updateItem,
  updateLocation
} from '../services/masterData.service';
import { getItemMetrics } from '../services/itemMetrics.service';
import { getUserBaseCurrency } from '../services/users.service';
import { ItemLifecycleStatus } from '../types/item';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/items', async (req: Request, res: Response) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!parsed.data.uomDimension || !parsed.data.canonicalUom || !parsed.data.stockingUom) {
    return res.status(400).json({ error: 'Canonical UOM fields are required for new items.' });
  }
  const reservedWorkOrderSku = /^WO-\d+$/i;
  if (reservedWorkOrderSku.test(parsed.data.sku.trim())) {
    return res
      .status(400)
      .json({ error: 'SKU is reserved for work order identifiers. Choose a different SKU.' });
  }
  try {
    const baseCurrency = await getUserBaseCurrency(req.auth!.userId);
    const item = await createItem(req.auth!.tenantId, parsed.data, baseCurrency);
    return res.status(201).json(item);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'SKU must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Default location must exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid item type.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    if (error instanceof Error && error.message.startsWith('ITEM_CANONICAL_UOM')) {
      return res.status(400).json({ error: 'Canonical UOM fields are required for new items.' });
    }
    console.error(error);
    if (process.env.NODE_ENV !== 'production') {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: 'Failed to create item.', detail });
    }
    return res.status(500).json({ error: 'Failed to create item.' });
  }
});

router.get('/items', async (req: Request, res: Response) => {
  const lifecycleStatus =
    typeof req.query.lifecycleStatus === 'string'
      ? (req.query.lifecycleStatus.split(',') as ItemLifecycleStatus[])
      : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const { items, total } = await listItems(req.auth!.tenantId, { lifecycleStatus, search, limit, offset });
    return res.json({ data: items, paging: { limit, offset, total } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list items.' });
  }
});

router.post('/items/metrics', async (req: Request, res: Response) => {
  const bodySchema = z.object({
    itemIds: z.array(uuidSchema).max(200),
    windowDays: z.number().int().min(1).max(365).optional()
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const windowDays = parsed.data.windowDays ?? 90;
  try {
    const metrics = await getItemMetrics(req.auth!.tenantId, parsed.data.itemIds, windowDays);
    return res.json({ data: metrics });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch item metrics.' });
  }
});

router.get('/items/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  try {
    const item = await getItem(req.auth!.tenantId, id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    return res.json(item);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch item.' });
  }
});

router.get('/items/:id/metrics', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  const windowDays = Math.min(365, Math.max(1, Number(req.query.windowDays) || 90));
  try {
    const metrics = await getItemMetrics(req.auth!.tenantId, [id], windowDays);
    return res.json(metrics[0] ?? { itemId: id, windowDays });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch item metrics.' });
  }
});

router.put('/items/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const reservedWorkOrderSku = /^WO-\d+$/i;
  if (reservedWorkOrderSku.test(parsed.data.sku.trim())) {
    return res
      .status(400)
      .json({ error: 'SKU is reserved for work order identifiers. Choose a different SKU.' });
  }
  try {
    const baseCurrency = await getUserBaseCurrency(req.auth!.userId);
    const item = await updateItem(req.auth!.tenantId, id, parsed.data, baseCurrency);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    return res.json(item);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'SKU must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Default location must exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid item type.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    if (error instanceof Error && error.message.startsWith('ITEM_CANONICAL_UOM')) {
      return res.status(400).json({ error: 'Canonical UOM fields are required for this update.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update item.' });
  }
});

router.post('/locations', async (req: Request, res: Response) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (parsed.data.parentLocationId && parsed.data.parentLocationId === req.body.id) {
    return res.status(400).json({ error: 'parentLocationId cannot reference itself.' });
  }
  try {
    const location = await createLocation(req.auth!.tenantId, parsed.data);
    return res.status(201).json(location);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Location code must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Parent location must exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid location type or hierarchy.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create location.' });
  }
});

router.get('/locations', async (req: Request, res: Response) => {
  const active =
    typeof req.query.active === 'string' ? req.query.active.toLowerCase() === 'true' : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const locations = await listLocations({ tenantId: req.auth!.tenantId, active, type, search, limit, offset });
    return res.json({ data: locations, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list locations.' });
  }
});

router.get('/locations/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid location id.' });
  }
  try {
    const location = await getLocation(req.auth!.tenantId, id);
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    return res.json(location);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch location.' });
  }
});

router.put('/locations/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid location id.' });
  }
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (parsed.data.parentLocationId && parsed.data.parentLocationId === id) {
    return res.status(400).json({ error: 'parentLocationId cannot reference itself.' });
  }
  try {
    const location = await updateLocation(req.auth!.tenantId, id, parsed.data);
    if (!location) return res.status(404).json({ error: 'Location not found.' });
    return res.json(location);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Location code must be unique.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Parent location must exist.' } }),
      check: () => ({ status: 400, body: { error: 'Invalid location type or hierarchy.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update location.' });
  }
});

const locationTemplateSchema = z.object({
  includeReceivingQc: z.boolean().optional()
});

router.post('/locations/templates/standard-warehouse', async (req: Request, res: Response) => {
  const parsed = locationTemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = await createStandardWarehouseTemplate(
      req.auth!.tenantId,
      parsed.data.includeReceivingQc ?? true
    );
    return res.status(result.created.length > 0 ? 201 : 200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create standard warehouse template.' });
  }
});

router.get('/items/:itemId/uom-conversions', async (req: Request, res: Response) => {
  const { itemId } = req.params;
  try {
    const conversions = await listUomConversionsByItem(req.auth!.tenantId, itemId);
    return res.json(conversions);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list UoM conversions.' });
  }
});

router.post('/items/:itemId/uom-conversions', async (req: Request, res: Response) => {
  const { itemId } = req.params;
  const parsed = uomConversionSchema.safeParse({ ...req.body, itemId });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const conversion = await createUomConversion(req.auth!.tenantId, parsed.data);
    return res.status(201).json(conversion);
  } catch (error) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Conversion already exists.' } }),
      foreignKey: () => ({ status: 400, body: { error: 'Item must exist.' } }),
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    if (error instanceof Error && error.message.startsWith('UOM_')) {
      return res.status(400).json({ error: error.message });
    }
    if ((error as any)?.code === 'COUNT_CONVERSION_FACTOR_MUST_BE_INTEGER') {
      return res.status(400).json({
        error: { code: 'COUNT_CONVERSION_FACTOR_MUST_BE_INTEGER', message: 'Count conversions require integer factors.' }
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create UoM conversion.' });
  }
});

router.delete('/uom-conversions/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await deleteUomConversion(req.auth!.tenantId, id);
    return res.status(204).send();
  } catch (error) {
    if ((error as Error)?.message === 'UOM_CONVERSION_IN_USE') {
      return res.status(409).json({ error: 'Conversion is in use and cannot be deleted.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to delete UoM conversion.' });
  }
});

export default router;
