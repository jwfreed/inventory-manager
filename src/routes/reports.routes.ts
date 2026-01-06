import { Router, type Request, type Response } from 'express';
import * as reportsService from '../services/reports.service';
import { ProductionVarianceService } from '../services/productionVariance.service';

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

/**
 * GET /reports/work-order-progress
 * Get work order progress report with completion percentages and late orders
 */
router.get('/work-order-progress', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      tenantId,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      status: req.query.status as string | undefined,
      itemId: req.query.itemId as string | undefined,
      includeCompleted: req.query.includeCompleted === 'true',
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getWorkOrderProgress(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/movement-transactions
 * Get movement transaction history with full audit trail
 */
router.get('/movement-transactions', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      tenantId,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      itemId: req.query.itemId as string | undefined,
      locationId: req.query.locationId as string | undefined,
      movementType: req.query.movementType as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getMovementTransactionHistory(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/inventory-velocity
 * Get inventory movement velocity analysis with turnover proxy
 */
router.get('/inventory-velocity', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      itemType: req.query.itemType as string | undefined,
      locationId: req.query.locationId as string | undefined,
      minMovements: req.query.minMovements 
        ? parseInt(req.query.minMovements as string, 10) 
        : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getInventoryMovementVelocity(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/open-po-aging
 * Get open purchase order aging report
 */
router.get('/open-po-aging', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      tenantId,
      vendorId: req.query.vendorId as string | undefined,
      minDaysOpen: req.query.minDaysOpen 
        ? parseInt(req.query.minDaysOpen as string, 10) 
        : undefined,
      includeFullyReceived: req.query.includeFullyReceived === 'true',
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getOpenPOAging(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/sales-order-fill
 * Get sales order fill performance report
 */
router.get('/sales-order-fill', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    const options = {
      tenantId,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      customerId: req.query.customerId as string | undefined,
      includeFullyShipped: req.query.includeFullyShipped === 'true',
      onlyLate: req.query.onlyLate === 'true',
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getSalesOrderFillPerformance(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/production-run-frequency
 * Get production run frequency analysis
 */
router.get('/production-run-frequency', async (req: Request, res: Response, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    
    if (!req.query.startDate || !req.query.endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const options = {
      tenantId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      itemType: req.query.itemType as string | undefined,
      itemId: req.query.itemId as string | undefined,
      minRuns: req.query.minRuns 
        ? parseInt(req.query.minRuns as string, 10) 
        : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const result = await reportsService.getProductionRunFrequency(options);
    
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /reports/bom-consumption-variance
 * Get BOM consumption variance report comparing actual vs expected consumption
 */
router.get('/bom-consumption-variance', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = req.query;

    const result = await ProductionVarianceService.getBomConsumptionVariance({
      tenantId,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      workOrderId: workOrderId as string | undefined,
      itemId: itemId as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });

    res.json(result);
  } catch (error) {
    console.error('Error getting BOM consumption variance:', error);
    res.status(500).json({ error: 'Failed to get BOM consumption variance' });
  }
});

/**
 * GET /reports/yield-variance
 * Get yield variance report comparing actual production vs expected from materials
 */
router.get('/yield-variance', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = req.query;

    const result = await ProductionVarianceService.getYieldReport({
      tenantId,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      workOrderId: workOrderId as string | undefined,
      itemId: itemId as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });

    res.json(result);
  } catch (error) {
    console.error('Error getting yield report:', error);
    res.status(500).json({ error: 'Failed to get yield report' });
  }
});

/**
 * GET /reports/execution-summary
 * Get execution summary with duration tracking and production details
 */
router.get('/execution-summary', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      startDate,
      endDate,
      workOrderId,
      itemId,
      limit = 100,
      offset = 0,
    } = req.query;

    const result = await ProductionVarianceService.getExecutionSummary({
      tenantId,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      workOrderId: workOrderId as string | undefined,
      itemId: itemId as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });

    res.json(result);
  } catch (error) {
    console.error('Error getting execution summary:', error);
    res.status(500).json({ error: 'Failed to get execution summary' });
  }
});

export default router;
