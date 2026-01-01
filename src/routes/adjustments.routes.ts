import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  cancelInventoryAdjustment,
  createInventoryAdjustment,
  getInventoryAdjustment,
  listInventoryAdjustments,
  postInventoryAdjustment,
  updateInventoryAdjustment
} from '../services/adjustments.service';
import { adjustmentListQuerySchema, inventoryAdjustmentSchema } from '../schemas/adjustments.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/inventory-adjustments', async (req: Request, res: Response) => {
  const parsed = adjustmentListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { status, occurred_from, occurred_to, item_id, location_id, limit, offset } = parsed.data;

  try {
    const data = await listInventoryAdjustments(req.auth!.tenantId, {
      status,
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
    return res.status(500).json({ error: 'Failed to list inventory adjustments.' });
  }
});

router.post('/inventory-adjustments', async (req: Request, res: Response) => {
  const parsed = inventoryAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const adjustment = await createInventoryAdjustment(req.auth!.tenantId, parsed.data, {
      type: 'user',
      id: req.auth!.userId
    });
    return res.status(201).json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within an adjustment.' });
    }
    if (error?.message === 'ADJUSTMENT_CORRECTION_NOT_FOUND') {
      return res.status(400).json({ error: 'Correction source adjustment was not found.' });
    }
    if (error?.message === 'ADJUSTMENT_CORRECTION_NOT_POSTED') {
      return res.status(409).json({ error: 'Only posted adjustments can be corrected.' });
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

router.put('/inventory-adjustments/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }
  const parsed = inventoryAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const adjustment = await updateInventoryAdjustment(req.auth!.tenantId, id, parsed.data, {
      type: 'user',
      id: req.auth!.userId
    });
    if (!adjustment) {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    return res.json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    if (error?.message === 'ADJUSTMENT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Line numbers must be unique within an adjustment.' });
    }
    if (error?.message === 'ADJUSTMENT_IMMUTABLE') {
      return res
        .status(409)
        .json({ error: 'Posted adjustments cannot be edited. Create a reversal adjustment instead.' });
    }
    if (error?.message === 'ADJUSTMENT_CANCELED') {
      return res.status(409).json({ error: 'Canceled adjustments cannot be edited.' });
    }
    if (error?.message === 'ADJUSTMENT_CORRECTION_SELF') {
      return res.status(400).json({ error: 'Adjustment cannot correct itself.' });
    }
    if (error?.message === 'ADJUSTMENT_CORRECTION_NOT_FOUND') {
      return res.status(400).json({ error: 'Correction source adjustment was not found.' });
    }
    if (error?.message === 'ADJUSTMENT_CORRECTION_NOT_POSTED') {
      return res.status(409).json({ error: 'Only posted adjustments can be corrected.' });
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
    return res.status(500).json({ error: 'Failed to update inventory adjustment.' });
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

router.delete('/inventory-adjustments/:id', async (_req: Request, res: Response) => {
  return res
    .status(409)
    .json({ error: 'Inventory adjustment deletes are disabled. Use the cancel endpoint instead.' });
});

router.post('/inventory-adjustments/:id/cancel', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const adjustment = await cancelInventoryAdjustment(tenantId, id, {
      type: 'user',
      id: req.auth!.userId
    });
    emitEvent(tenantId, 'inventory.adjustment.canceled', {
      adjustmentId: id,
      status: adjustment?.status
    });
    return res.json(adjustment);
  } catch (error: any) {
    if (error?.message === 'ADJUSTMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    if (error?.message === 'ADJUSTMENT_ALREADY_CANCELED') {
      return res.status(409).json({ error: 'Inventory adjustment already canceled.' });
    }
    if (error?.message === 'ADJUSTMENT_NOT_CANCELLABLE') {
      return res
        .status(409)
        .json({ error: 'Posted adjustments cannot be canceled. Create a reversal adjustment instead.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to cancel inventory adjustment.' });
  }
});

router.post('/inventory-adjustments/:id/post', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid adjustment id.' });
  }
  const overrideSchema = z
    .object({
      overrideNegative: z.boolean().optional(),
      overrideReason: z.string().max(2000).optional()
    })
    .safeParse(req.body ?? {});
  if (!overrideSchema.success) {
    return res.status(400).json({ error: overrideSchema.error.flatten() });
  }

  try {
    const tenantId = req.auth!.tenantId;
    const adjustment = await postInventoryAdjustment(tenantId, id, {
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested: overrideSchema.data.overrideNegative,
      overrideReason: overrideSchema.data.overrideReason
    });

    if (!adjustment) {
      throw new Error('Failed to retrieve adjustment after posting');
    }

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
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED',
          message: error.details?.message,
          details: error.details
        }
      });
    }
    if (error?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON',
          message: error.details?.message,
          details: error.details
        }
      });
    }
    if (error?.message === 'ADJUSTMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    if (error?.message === 'ADJUSTMENT_ALREADY_POSTED') {
      return res.status(409).json({ error: 'Inventory adjustment already posted.' });
    }
    if (error?.message === 'ADJUSTMENT_CANCELED') {
      return res.status(409).json({ error: 'Canceled adjustments cannot be posted.' });
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
