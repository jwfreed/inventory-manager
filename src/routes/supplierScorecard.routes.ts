import { Router, type Request, type Response } from 'express';
import {
  supplierScorecardQuerySchema,
  supplierScorecardDetailQuerySchema,
  topSuppliersQuerySchema,
  qualityIssuesQuerySchema
} from '../schemas/supplierScorecard.schema';
import {
  getSupplierScorecards,
  getSupplierScorecardDetail,
  getTopSuppliersByDelivery,
  getTopSuppliersByQuality,
  getSuppliersWithQualityIssues
} from '../services/supplierScorecard.service';

const router = Router();

/**
 * GET /supplier-scorecards
 * Get supplier scorecards with on-time delivery and quality metrics
 * Query params: vendorId, startDate, endDate, limit, offset
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = supplierScorecardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const scorecards = await getSupplierScorecards(req.auth!.tenantId, parsed.data);
    return res.json({ data: scorecards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load supplier scorecards.' });
  }
});

/**
 * GET /supplier-scorecards/:vendorId
 * Get detailed scorecard for a specific supplier
 * Query params: startDate, endDate (optional)
 */
router.get('/:vendorId', async (req: Request, res: Response) => {
  const { vendorId } = req.params;
  const parsed = supplierScorecardDetailQuerySchema.safeParse({
    vendorId,
    ...req.query
  });

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const scorecard = await getSupplierScorecardDetail(
      req.auth!.tenantId,
      parsed.data.vendorId,
      parsed.data.startDate,
      parsed.data.endDate
    );

    if (!scorecard) {
      return res.status(404).json({ error: 'Supplier scorecard not found.' });
    }

    return res.json({ data: scorecard });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load supplier scorecard.' });
  }
});

/**
 * GET /supplier-scorecards/rankings/delivery
 * Get top performing suppliers by on-time delivery
 * Query params: limit (optional, default 10)
 */
router.get('/rankings/delivery', async (req: Request, res: Response) => {
  const parsed = topSuppliersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const scorecards = await getTopSuppliersByDelivery(
      req.auth!.tenantId,
      parsed.data.limit
    );
    return res.json({ data: scorecards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load top suppliers by delivery.' });
  }
});

/**
 * GET /supplier-scorecards/rankings/quality
 * Get top performing suppliers by quality
 * Query params: limit (optional, default 10)
 */
router.get('/rankings/quality', async (req: Request, res: Response) => {
  const parsed = topSuppliersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const scorecards = await getTopSuppliersByQuality(
      req.auth!.tenantId,
      parsed.data.limit
    );
    return res.json({ data: scorecards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load top suppliers by quality.' });
  }
});

/**
 * GET /supplier-scorecards/issues/quality
 * Get suppliers with quality issues (high rejection rates or open NCRs)
 * Query params: minRejectionRate (optional, default 5%)
 */
router.get('/issues/quality', async (req: Request, res: Response) => {
  const parsed = qualityIssuesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  try {
    const scorecards = await getSuppliersWithQualityIssues(
      req.auth!.tenantId,
      parsed.data.minRejectionRate
    );
    return res.json({ data: scorecards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load suppliers with quality issues.' });
  }
});

export default router;
