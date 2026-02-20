import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createInventoryCount,
  getInventoryCount,
  listInventoryCounts,
  postInventoryCount,
  updateInventoryCount
} from '../services/counts.service';
import { inventoryCountSchema, inventoryCountUpdateSchema } from '../schemas/counts.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';
import { getIdempotencyKey } from '../lib/idempotency';
import { mapTxRetryExhausted } from './orderToCash.shipmentConflicts';

const router = Router();
const uuidSchema = z.string().uuid();

router.get('/inventory-counts', async (req: Request, res: Response) => {
  const warehouseId =
    typeof req.query.warehouse_id === 'string'
      ? req.query.warehouse_id
      : typeof req.query.warehouseId === 'string'
        ? req.query.warehouseId
        : null;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const role = req.auth?.role ?? null;
  if (!warehouseId && !(role === 'supervisor' && status === 'draft')) {
    return res.status(400).json({
      error: {
        code: 'WAREHOUSE_SCOPE_REQUIRED',
        message: 'warehouseId is required.'
      }
    });
  }
  if (warehouseId && !uuidSchema.safeParse(warehouseId).success) {
    return res.status(400).json({ error: 'Invalid warehouse id.' });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const rows = await listInventoryCounts(req.auth!.tenantId, warehouseId, status, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list inventory counts.' });
  }
});

router.post('/inventory-counts', async (req: Request, res: Response) => {
  const parsed = inventoryCountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const count = await createInventoryCount(req.auth!.tenantId, parsed.data, {
      idempotencyKey: getIdempotencyKey(req)
    });
    return res.status(201).json(count);
  } catch (error: any) {
    if (error?.message === 'WAREHOUSE_SCOPE_REQUIRED') {
      return res.status(400).json({
        error: {
          code: 'WAREHOUSE_SCOPE_REQUIRED',
          message: 'warehouseId is required for inventory counts.'
        }
      });
    }
    if (error?.message === 'WAREHOUSE_SCOPE_MISMATCH') {
      return res.status(409).json({
        error: {
          code: 'WAREHOUSE_SCOPE_MISMATCH',
          message: 'Count line location is outside the selected warehouse scope.'
        }
      });
    }
    if (error?.message === 'COUNT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Each count line requires a locationId.' });
    }
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

router.patch('/inventory-counts/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid inventory count id.' });
  }
  const parsed = inventoryCountUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const count = await updateInventoryCount(req.auth!.tenantId, id, parsed.data);
    return res.json(count);
  } catch (error: any) {
    if (error?.message === 'COUNT_NOT_FOUND') {
      return res.status(404).json({ error: 'Inventory count not found.' });
    }
    if (error?.message === 'COUNT_NOT_DRAFT') {
      return res.status(409).json({ error: 'Only draft counts can be edited.' });
    }
    if (error?.message === 'WAREHOUSE_SCOPE_MISMATCH') {
      return res.status(409).json({
        error: {
          code: 'WAREHOUSE_SCOPE_MISMATCH',
          message: 'Count line location is outside the selected warehouse scope.'
        }
      });
    }
    if (error?.message === 'COUNT_LOCATION_REQUIRED') {
      return res.status(400).json({ error: 'Each count line requires a locationId.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update inventory count.' });
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
    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Idempotency-Key header is required.' });
    }
    const count = await postInventoryCount(tenantId, id, idempotencyKey, {
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested: overrideSchema.data.overrideNegative,
      overrideReason: overrideSchema.data.overrideReason
    });

    if (!count) {
      throw new Error('Failed to retrieve count after posting');
    }

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
    if (mapTxRetryExhausted(error, res)) {
      return;
    }
    if (error?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: error.details?.message, details: error.details }
      });
    }
    if (error?.code === 'DISCRETE_UOM_REQUIRES_INTEGER') {
      return res.status(400).json({
        error: {
          code: 'DISCRETE_UOM_REQUIRES_INTEGER',
          message: error.details?.message,
          details: error.details
        }
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
    if (error?.message === 'CYCLE_COUNT_UNIT_COST_REQUIRED') {
      return res.status(409).json({
        error: {
          code: 'CYCLE_COUNT_UNIT_COST_REQUIRED',
          message: 'Positive cycle count variances require unitCostForPositiveAdjustment.'
        }
      });
    }
    if (error?.message === 'CYCLE_COUNT_RECONCILIATION_FAILED') {
      return res.status(409).json({
        error: {
          code: 'CYCLE_COUNT_RECONCILIATION_FAILED',
          message: 'Cycle count posting failed reconciliation against current on-hand.'
        }
      });
    }
    if (error?.code === 'INV_COUNT_POST_IDEMPOTENCY_CONFLICT' || error?.message === 'INV_COUNT_POST_IDEMPOTENCY_CONFLICT') {
      return res.status(409).json({
        error: {
          code: 'INV_COUNT_POST_IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key payload conflict detected for inventory count posting.',
          details: error?.details
        }
      });
    }
    if (error?.code === 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE' || error?.message === 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE') {
      return res.status(409).json({
        error: {
          code: 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE',
          message: 'Inventory count posting is incomplete for this idempotency key.',
          details: error?.details
        }
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post inventory count.' });
  }
});

export default router;
