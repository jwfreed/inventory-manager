import { Router, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthenticatedRequest } from '../types/auth';

const router = Router();

router.use(requireAuth);

/**
 * POST /metrics/compute/abc-classification
 * Compute ABC classification and update items table
 */
router.post('/compute/abc-classification', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { windowDays = 90 } = req.body;

    const updatedCount = await MetricsService.updateAbcClassifications(tenantId, windowDays);

    res.json({
      success: true,
      message: `ABC classification computed for ${updatedCount} items`,
      updatedCount,
    });
  } catch (error) {
    console.error('Error computing ABC classification:', error);
    res.status(500).json({ error: 'Failed to compute ABC classification' });
  }
});

/**
 * GET /metrics/abc-classification
 * Get current ABC classification results
 */
router.get('/abc-classification', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { windowDays = 90 } = req.query;

    const results = await MetricsService.computeAbcClassification(
      tenantId,
      parseInt(windowDays as string)
    );

    res.json({ data: results });
  } catch (error) {
    console.error('Error fetching ABC classification:', error);
    res.status(500).json({ error: 'Failed to fetch ABC classification' });
  }
});

/**
 * GET /metrics/inventory-aging
 * Get inventory aging buckets
 */
router.get('/inventory-aging', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const results = await MetricsService.computeInventoryAging(tenantId);

    res.json({ data: results });
  } catch (error) {
    console.error('Error computing inventory aging:', error);
    res.status(500).json({ error: 'Failed to compute inventory aging' });
  }
});

/**
 * POST /metrics/compute/slow-dead-stock
 * Compute slow/dead stock flags and update items table
 */
router.post('/compute/slow-dead-stock', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { slowThresholdDays = 90, deadThresholdDays = 180 } = req.body;

    const updatedCount = await MetricsService.updateSlowDeadStockFlags(
      tenantId,
      slowThresholdDays,
      deadThresholdDays
    );

    res.json({
      success: true,
      message: `Slow/dead stock flags updated for ${updatedCount} items`,
      updatedCount,
    });
  } catch (error) {
    console.error('Error computing slow/dead stock:', error);
    res.status(500).json({ error: 'Failed to compute slow/dead stock' });
  }
});

/**
 * GET /metrics/slow-dead-stock
 * Get slow-moving and dead stock items
 */
router.get('/slow-dead-stock', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      slowThresholdDays = 90,
      deadThresholdDays = 180,
    } = req.query;

    const results = await MetricsService.identifySlowDeadStock(
      tenantId,
      parseInt(slowThresholdDays as string),
      parseInt(deadThresholdDays as string)
    );

    res.json({ data: results });
  } catch (error) {
    console.error('Error fetching slow/dead stock:', error);
    res.status(500).json({ error: 'Failed to fetch slow/dead stock' });
  }
});

/**
 * GET /metrics/turns-doi
 * Compute inventory turns and DOI for a time window
 */
router.get('/turns-doi', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd = new Date().toISOString(),
    } = req.query;

    const results = await MetricsService.computeTurnsAndDoi(
      tenantId,
      new Date(windowStart as string),
      new Date(windowEnd as string)
    );

    res.json({ data: results });
  } catch (error) {
    console.error('Error computing turns/DOI:', error);
    res.status(500).json({ error: 'Failed to compute turns/DOI' });
  }
});

/**
 * POST /metrics/compute/turns-doi
 * Compute and store turns/DOI snapshots in kpi_snapshots table
 */
router.post('/compute/turns-doi', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd = new Date().toISOString(),
    } = req.body;

    const runId = await MetricsService.storeTurnsAndDoi(
      tenantId,
      new Date(windowStart),
      new Date(windowEnd)
    );

    res.json({
      success: true,
      message: 'Turns and DOI computed and stored',
      runId,
    });
  } catch (error) {
    console.error('Error computing and storing turns/DOI:', error);
    res.status(500).json({ error: 'Failed to compute and store turns/DOI' });
  }
});

/**
 * POST /metrics/compute/all
 * Trigger all metric calculations at once
 */
router.post('/compute/all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      abcWindowDays = 90,
      slowThresholdDays = 90,
      deadThresholdDays = 180,
      turnsWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      turnsWindowEnd = new Date().toISOString(),
    } = req.body;

    const results = {
      abcUpdated: 0,
      slowDeadUpdated: 0,
      turnsDoiRunId: '',
    };

    // Compute ABC classification
    results.abcUpdated = await MetricsService.updateAbcClassifications(tenantId, abcWindowDays);

    // Compute slow/dead stock
    results.slowDeadUpdated = await MetricsService.updateSlowDeadStockFlags(
      tenantId,
      slowThresholdDays,
      deadThresholdDays
    );

    // Compute and store turns/DOI
    results.turnsDoiRunId = await MetricsService.storeTurnsAndDoi(
      tenantId,
      new Date(turnsWindowStart),
      new Date(turnsWindowEnd)
    );

    res.json({
      success: true,
      message: 'All metrics computed successfully',
      results,
    });
  } catch (error) {
    console.error('Error computing all metrics:', error);
    res.status(500).json({ error: 'Failed to compute all metrics' });
  }
});

export default router;
