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
import { getIdempotencyKey } from '../lib/idempotency';
import { 
  validateBody, 
  validateQuery, 
  validateUuidParam, 
  asyncErrorHandler,
  adjustmentErrorMap
} from '../middleware/validation';

const router = Router();

// GET /inventory-adjustments - List adjustments with filters
router.get(
  '/inventory-adjustments',
  validateQuery(adjustmentListQuerySchema),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { status, occurred_from, occurred_to, item_id, location_id, limit, offset } = req.validatedQuery;

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
  })
);

// POST /inventory-adjustments - Create new adjustment
router.post(
  '/inventory-adjustments',
  validateBody(inventoryAdjustmentSchema),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const adjustment = await createInventoryAdjustment(
      req.auth!.tenantId,
      req.validatedBody,
      { type: 'user', id: req.auth!.userId },
      { idempotencyKey: getIdempotencyKey(req) }
    );
    return res.status(201).json(adjustment);
  }, {
    ...adjustmentErrorMap,
    // Add database constraint error handling
    ...((error: any) => {
      const mapped = mapPgErrorToHttp(error, {
        foreignKey: () => ({
          status: 400,
          body: { error: 'Invalid reference: ensure item and location exist before adjustment.' }
        })
      });
      return mapped ? { status: mapped.status, body: mapped.body } : null;
    })
  } as any)
);

// PUT /inventory-adjustments/:id - Update adjustment
router.put(
  '/inventory-adjustments/:id',
  validateUuidParam('id'),
  validateBody(inventoryAdjustmentSchema),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const adjustment = await updateInventoryAdjustment(req.auth!.tenantId, id, req.validatedBody, {
      type: 'user',
      id: req.auth!.userId
    });
    if (!adjustment) {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    return res.json(adjustment);
  }, {
    ...adjustmentErrorMap,
    ...((error: any) => {
      const mapped = mapPgErrorToHttp(error, {
        foreignKey: () => ({
          status: 400,
          body: { error: 'Invalid reference: ensure item and location exist before adjustment.' }
        })
      });
      return mapped ? { status: mapped.status, body: mapped.body } : null;
    })
  } as any)
);

// GET /inventory-adjustments/:id - Get adjustment by ID
router.get(
  '/inventory-adjustments/:id',
  validateUuidParam('id'),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const adjustment = await getInventoryAdjustment(req.auth!.tenantId, id);
    if (!adjustment) {
      return res.status(404).json({ error: 'Inventory adjustment not found.' });
    }
    return res.json(adjustment);
  })
);

// DELETE /inventory-adjustments/:id - Disabled in favor of cancel
router.delete('/inventory-adjustments/:id', (_req: Request, res: Response) => {
  return res
    .status(409)
    .json({ error: 'Inventory adjustment deletes are disabled. Use the cancel endpoint instead.' });
});

// POST /inventory-adjustments/:id/cancel - Cancel adjustment
router.post(
  '/inventory-adjustments/:id/cancel',
  validateUuidParam('id'),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
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
  }, adjustmentErrorMap)
);

// POST /inventory-adjustments/:id/post - Post adjustment to create movement
router.post(
  '/inventory-adjustments/:id/post',
  validateUuidParam('id'),
  validateBody(z.object({
    overrideNegative: z.boolean().optional(),
    overrideReason: z.string().max(2000).optional()
  })),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const tenantId = req.auth!.tenantId;
    
    const adjustment = await postInventoryAdjustment(tenantId, id, {
      actor: { type: 'user', id: req.auth!.userId, role: req.auth!.role },
      overrideRequested: req.validatedBody.overrideNegative,
      overrideReason: req.validatedBody.overrideReason
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
  }, {
    ...adjustmentErrorMap,
    'INSUFFICIENT_STOCK': (error: any) => ({
      status: 409,
      body: { 
        error: { 
          code: 'INSUFFICIENT_STOCK', 
          message: error.details?.message, 
          details: error.details 
        }
      }
    }),
    'DISCRETE_UOM_REQUIRES_INTEGER': (error: any) => ({
      status: 400,
      body: {
        error: {
          code: 'DISCRETE_UOM_REQUIRES_INTEGER',
          message: error.details?.message,
          details: error.details
        }
      }
    }),
    'NEGATIVE_OVERRIDE_NOT_ALLOWED': (error: any) => ({
      status: 403,
      body: {
        error: {
          code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED',
          message: error.details?.message,
          details: error.details
        }
      }
    }),
    'NEGATIVE_OVERRIDE_REQUIRES_REASON': (error: any) => ({
      status: 409,
      body: {
        error: {
          code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON',
          message: error.details?.message,
          details: error.details
        }
      }
    })
  })
);

export default router;
