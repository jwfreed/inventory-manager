import { Router, type Request, type Response } from 'express';
import { atpQuerySchema, atpDetailQuerySchema, atpCheckSchema } from '../schemas/atp.schema';
import {
  getAvailableToPromise,
  getAvailableToPromiseDetail,
  checkAtpSufficiency
} from '../services/atp.service';

const router = Router();

function requireWarehouseId(
  warehouseId: unknown,
  res: Response
): warehouseId is string {
  if (typeof warehouseId === 'string' && warehouseId.trim().length > 0) return true;
  res.status(400).json({
    error: {
      code: 'WAREHOUSE_ID_REQUIRED',
      message: 'warehouseId is required.'
    }
  });
  return false;
}

/**
 * GET /atp
 * Query Available to Promise across items and locations
 * Query params: itemId, locationId, limit, offset
 */
router.get('/', async (req: Request, res: Response) => {
  const warehouseId = Array.isArray(req.query.warehouseId) ? req.query.warehouseId[0] : req.query.warehouseId;
  if (!requireWarehouseId(warehouseId, res)) {
    return;
  }

  const parsed = atpQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const results = await getAvailableToPromise(req.auth!.tenantId, parsed.data);
    return res.json({ data: results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to calculate ATP.' });
  }
});

/**
 * GET /atp/detail
 * Get ATP for a specific item/location/uom
 * Query params: itemId (required), locationId (required), uom (optional)
 */
router.get('/detail', async (req: Request, res: Response) => {
  const warehouseId = Array.isArray(req.query.warehouseId) ? req.query.warehouseId[0] : req.query.warehouseId;
  if (!requireWarehouseId(warehouseId, res)) {
    return;
  }

  const parsed = atpDetailQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  const { warehouseId: parsedWarehouseId, itemId, locationId, uom } = parsed.data;

  try {
    const result = await getAvailableToPromiseDetail(req.auth!.tenantId, parsedWarehouseId, itemId, locationId, uom);
    
    if (!result) {
      return res.status(404).json({ error: 'No inventory found for the specified item/location.' });
    }

    return res.json({ data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to calculate ATP detail.' });
  }
});

/**
 * POST /atp/check
 * Check if sufficient ATP exists for a requested quantity
 * Body: { itemId, locationId, uom, quantity }
 */
router.post('/check', async (req: Request, res: Response) => {
  if (!requireWarehouseId(req.body?.warehouseId, res)) {
    return;
  }

  const parsed = atpCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body.', details: parsed.error.format() });
  }

  const { warehouseId: parsedWarehouseId, itemId, locationId, uom, quantity } = parsed.data;

  try {
    const result = await checkAtpSufficiency(
      req.auth!.tenantId,
      parsedWarehouseId,
      itemId,
      locationId,
      uom,
      quantity
    );

    return res.json({ data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to check ATP sufficiency.' });
  }
});

export default router;
