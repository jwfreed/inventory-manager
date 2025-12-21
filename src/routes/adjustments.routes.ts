import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createInventoryAdjustment,
  getInventoryAdjustment,
  postInventoryAdjustment
} from '../services/adjustments.service';
import { inventoryAdjustmentSchema } from '../schemas/adjustments.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/inventory-adjustments', async (req: Request, res: Response) => {
  const parsed = inventoryAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const adjustment = await createInventoryAdjustment(req.auth!.tenantId, parsed.data);
    return res.status(201).json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within an adjustment.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      foreignKey: () => ({
        status: 400,
        body: { error: 'Invalid reference: ensure item and location exist before adjustment.' }
      })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create inventory adjustment.' });
  }
});

router.get('/inventory-adjustments/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }

  try {
    const adjustment = await getInventoryAdjustment(req.auth!.tenantId, id);
    if (!adjustment) {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    return res.json(adjustment);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch inventory adjustment.' });
  }
});

router.post('/inventory-adjustments/:id/post', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const adjustment = await postInventoryAdjustment(tenantId, id);
    const itemIds = Array.from(new Set(adjustment.lines.map((line) => line.itemId)));
    const locationIds = Array.from(new Set(adjustment.lines.map((line) => line.locationId)));
    emitEvent(tenantId, 'inventory.adjustment.posted', {
      adjustmentId: adjustment.id,
      movementId: adjustment.inventoryMovementId,
      itemIds,
      locationIds
    });
    return res.json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    if (error?.message === 'ADJUSTMENT_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Inventory adjustment already posted.' });
    }
    if (error?.message === 'ADJUSTMENT_CANCELED') {
      return res.status(400).json({ error: 'Canceled adjustments cannot be posted.' });
    }
    if (error?.message === 'ADJUSTMENT_NO_LINES') {
      return res.status(400).json({ error: 'Inventory adjustment has no lines to post.' });
    }
    if (error?.message === 'ADJUSTMENT_LINE_ZERO') {
      return res.status(400).json({ error: 'Inventory adjustment lines must have non-zero quantity.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory adjustment.' });
  }
});

export default router;
