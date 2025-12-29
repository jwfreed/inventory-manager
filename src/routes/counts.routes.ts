import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createInventoryCount, getInventoryCount, postInventoryCount } from '../services/counts.service';
import { inventoryCountSchema } from '../schemas/counts.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/inventory-counts', async (req: Request, res: Response) => {
  const parsed = inventoryCountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const count = await createInventoryCount(req.auth!.tenantId, parsed.data);
    return res.status(201).json(count);
  } catch (error: any) {
    if (error?.message === 'COUNT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within a cycle count.' });
    }
    if (error?.message === 'COUNT_DUPLICATE_ITEM') {
      return res.status(400).json({ error: 'Each item/UOM may only appear once in a cycle count.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Invalid reference: ensure location and items exist before counting.' }
      })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory count.' });
  }
});

router.get('/inventory-counts/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid inventory count id.' });
  }

  try {
    const count = await getInventoryCount(req.auth!.tenantId, id);
    if (!count) {
      return res.status(404).json({ error: 'Inventory count not found.' });
    }
    return res.json(count);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory count.' });
  }
});

router.post('/inventory-counts/:id/post', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid inventory count id.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const count = await postInventoryCount(tenantId, id);
    const itemIds = Array.from(new Set(count.lines.map((line) => line.itemId)));
    emitEvent(tenantId, 'inventory.count.posted', {
      countId: count.id,
      adjustmentId: count.inventoryAdjustmentId,
      movementId: count.inventoryMovementId,
      locationId: count.locationId,
      itemIds
    });
    return res.json(count);
  } catch (error: any) {
    if (error?.message === 'COUNT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory count not found.' });
    }
    if (error?.message === 'COUNT_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Inventory count already posted.' });
    }
    if (error?.message === 'COUNT_CANCELED') {
      return res.status(409).json({ error: 'Canceled counts cannot be posted.' });
    }
    if (error?.message === 'COUNT_NO_LINES') {
      return res.status(400).json({ error: 'Inventory count has no lines to post.' });
    }
    if (error?.message === 'COUNT_REASON_REQUIRED') {
      return res.status(409).json({
        error: 'Reason code required for any line with a non-zero variance.'
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory count.' });
  }
});

export default router;
