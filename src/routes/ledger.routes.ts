import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { movementListQuerySchema, movementWindowQuerySchema } from '../schemas/ledger.schema';
import { getMovement, getMovementLines, getMovementWindow, listMovements } from '../services/ledger.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/inventory-movements', async (req: Request, res: Response) => {
  const parsed = movementListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { movement_type, status, external_ref, occurred_from, occurred_to, item_id, location_id, limit, offset } =
    parsed.data;

  try {
    const data = await listMovements(req.auth!.tenantId, {
      movementType: movement_type,
      status,
      externalRef: external_ref,
      occurredFrom: occurred_from,
      occurredTo: occurred_to,
      itemId: item_id,
      locationId: location_id,
      limit: limit ?? 50,
      offset: offset ?? 0
    });
    return res.json({ data, paging: { limit: limit ?? 50, offset: offset ?? 0 } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list inventory movements.' });
  }
});

router.get('/inventory-movements/window', async (req: Request, res: Response) => {
  const parsed = movementWindowQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!parsed.data.item_id && !parsed.data.location_id) {
    return res.status(400).json({ error: 'item_id or location_id is required.' });
  }
  try {
    const window = await getMovementWindow(req.auth!.tenantId, {
      itemId: parsed.data.item_id,
      locationId: parsed.data.location_id
    });
    return res.json({ data: window });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load inventory movement window.' });
  }
});

router.get('/inventory-movements/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid movement id.' });
  }
  try {
    const movement = await getMovement(req.auth!.tenantId, id);
    if (!movement) return res.status(404).json({ error: 'Inventory movement not found.' });
    return res.json(movement);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory movement.' });
  }
});

router.get('/inventory-movements/:id/lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid movement id.' });
  }
  try {
    const lines = await getMovementLines(req.auth!.tenantId, id);
    return res.json({ data: lines });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory movement lines.' });
  }
});

export default router;
