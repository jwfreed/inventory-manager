import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { itemSchema, locationSchema } from '../schemas/masterData.schema';
import {
  createItem,
  createLocation,
  getItem,
  getLocation,
  listItems,
  listLocations,
  updateItem,
  updateLocation
} from '../services/masterData.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/items', async (req: Request, res: Response) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const item = await createItem(parsed.data);
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
    console.error(error);
    return res.status(500).json({ error: 'Failed to create item.' });
  }
});

router.get('/items', async (req: Request, res: Response) => {
  const active =
    typeof req.query.active === 'string' ? req.query.active.toLowerCase() === 'true' : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const items = await listItems({ active, search, limit, offset });
    return res.json({ data: items, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list items.' });
  }
});

router.get('/items/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  try {
    const item = await getItem(id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    return res.json(item);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch item.' });
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
  try {
    const item = await updateItem(id, parsed.data);
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
    const location = await createLocation(parsed.data);
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
    const locations = await listLocations({ active, type, search, limit, offset });
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
    const location = await getLocation(id);
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
    const location = await updateLocation(id, parsed.data);
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

export default router;
