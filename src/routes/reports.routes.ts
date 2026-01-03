import { Router, type Request, type Response } from 'express';
import * as reportsService from '../services/reports.service';

const router = Router();

/**
 * GET /reports/inventory-valuation
 * Get inventory valuation report with quantity on hand and extended values
 */
router.get('/inventory-valuation', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      locationId: req.query.locationId as string | undefined,
      itemType: req.query.itemType as string | undefined,
      includeZeroQty: req.query.includeZeroQty === 'true',
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getInventoryValuation(tenantId, options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/cost-variance
 * Get cost variance report showing differences between standard and average costs
 */
router.get('/cost-variance', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      minVariancePercent: req.query.minVariancePercent 
        ? parseFloat(req.query.minVariancePercent as string) 
        : undefined,
      itemType: req.query.itemType as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getCostVariance(tenantId, options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/receipt-cost-analysis
 * Get receipt cost analysis comparing expected vs actual costs
 */
router.get('/receipt-cost-analysis', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      vendorId: req.query.vendorId as string | undefined,
      minVariancePercent: req.query.minVariancePercent 
        ? parseFloat(req.query.minVariancePercent as string) 
        : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getReceiptCostAnalysis(tenantId, options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
