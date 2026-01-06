import { Router, Request, Response } from 'express';
import * as supplierPerformanceService from '../services/supplierPerformance.service';

const router = Router();

/**
 * GET /supplier-performance/lead-time-reliability
 * Get lead time reliability metrics by vendor
 */
router.get('/lead-time-reliability', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;

    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      vendorId: req.query.vendorId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await supplierPerformanceService.getLeadTimeReliability(options);

    res.json(result);
  } catch (error) {
    console.error('Error getting lead time reliability:', error);
    res.status(500).json({ error: 'Failed to get lead time reliability' });
  }
});

/**
 * GET /supplier-performance/price-variance-trends
 * Get price variance trends over time by vendor
 */
router.get('/price-variance-trends', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;

    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      vendorId: req.query.vendorId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await supplierPerformanceService.getPriceVarianceTrends(options);

    res.json(result);
  } catch (error) {
    console.error('Error getting price variance trends:', error);
    res.status(500).json({ error: 'Failed to get price variance trends' });
  }
});

/**
 * GET /supplier-performance/vendor-fill-rate
 * Get vendor fill rate metrics
 */
router.get('/vendor-fill-rate', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;

    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      vendorId: req.query.vendorId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await supplierPerformanceService.getVendorFillRate(options);

    res.json(result);
  } catch (error) {
    console.error('Error getting vendor fill rate:', error);
    res.status(500).json({ error: 'Failed to get vendor fill rate' });
  }
});

/**
 * GET /supplier-performance/quality-rate
 * Get vendor quality rate metrics (placeholder)
 */
router.get('/quality-rate', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;

    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      vendorId: req.query.vendorId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await supplierPerformanceService.getVendorQualityRate(options);

    res.json(result);
  } catch (error) {
    console.error('Error getting quality rate:', error);
    res.status(500).json({ error: 'Failed to get quality rate' });
  }
});

export default router;
