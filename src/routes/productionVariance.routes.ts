import { Router, Request, Response } from 'express';
import { ProductionVarianceService } from '../services/productionVariance.service';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

/**
 * GET /production-variance/bom-consumption
 * Get BOM consumption variance report comparing actual vs expected consumption
 */
router.get('/bom-consumption', async (req: Request, res: Response) => {
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
 * GET /production-variance/yield
 * Get yield variance report comparing actual production vs expected from materials
 */
router.get('/yield', async (req: Request, res: Response) => {
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
 * GET /production-variance/execution-summary
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
