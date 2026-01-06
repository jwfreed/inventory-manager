import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getProductionOverview,
  getProductionVolumeTrend,
  getTopBottomSKUs,
  getWIPStatusSummary,
  getMaterialsConsumed
} from '../services/productionOverview.service';

const router = Router();

const productionOverviewQuerySchema = z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  itemId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  workCenterId: z.string().uuid().optional()
});

/**
 * GET /api/production-overview
 * Get combined production overview data
 */
router.get('/production-overview', async (req: Request, res: Response) => {
  const parsed = productionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await getProductionOverview(req.auth!.tenantId, parsed.data);
    return res.json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch production overview.' });
  }
});

/**
 * GET /api/production-overview/volume-trend
 * Get production volume trend data
 */
router.get('/production-overview/volume-trend', async (req: Request, res: Response) => {
  const parsed = productionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await getProductionVolumeTrend(req.auth!.tenantId, parsed.data);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch production volume trend.' });
  }
});

/**
 * GET /api/production-overview/top-bottom-skus
 * Get top/bottom SKUs by production frequency and batch size
 */
router.get('/production-overview/top-bottom-skus', async (req: Request, res: Response) => {
  const parsed = productionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await getTopBottomSKUs(req.auth!.tenantId, parsed.data);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch top/bottom SKUs.' });
  }
});

/**
 * GET /api/production-overview/wip-status
 * Get WIP status summary
 */
router.get('/production-overview/wip-status', async (req: Request, res: Response) => {
  const parsed = productionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await getWIPStatusSummary(req.auth!.tenantId, parsed.data);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch WIP status summary.' });
  }
});

/**
 * GET /api/production-overview/materials-consumed
 * Get materials consumed from work_order_execution_lines
 */
router.get('/production-overview/materials-consumed', async (req: Request, res: Response) => {
  const parsed = productionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const data = await getMaterialsConsumed(req.auth!.tenantId, parsed.data);
    return res.json({ data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch materials consumed.' });
  }
});

export default router;
