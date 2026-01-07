import { Router, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service';
import { requireAuth } from '../middleware/auth.middleware';
import { cacheAdapter } from '../lib/redis';

const router = Router();

router.use(requireAuth);

/**
 * POST /metrics/compute/abc-classification
 * Compute ABC classification and update items table
 * Invalidates cache after computation
 */
router.post('/compute/abc-classification', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { windowDays = 90 } = req.body;

    const updatedCount = await MetricsService.updateAbcClassifications(tenantId, windowDays);
    
    // Invalidate cache after update
    await MetricsService.invalidateCache(tenantId, 'abc_classification');

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
 * Get current ABC classification results (cached)
 */
router.get('/abc-classification', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { windowDays = 90 } = req.query;

    const results = await MetricsService.getABCClassification(
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
 * Get inventory aging buckets (cached)
 */
router.get('/inventory-aging', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;

    const results = await MetricsService.getInventoryAging(tenantId);

    res.json({ data: results });
  } catch (error) {
    console.error('Error computing inventory aging:', error);
    res.status(500).json({ error: 'Failed to compute inventory aging' });
  }
});

/**
 * POST /metrics/compute/slow-dead-stock
 * Compute slow/dead stock flags and update items table
 * Invalidates cache after computation
 */
router.post('/compute/slow-dead-stock', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { slowThresholdDays = 90, deadThresholdDays = 180 } = req.body;

    const updatedCount = await MetricsService.updateSlowDeadStockFlags(
      tenantId,
      slowThresholdDays,
      deadThresholdDays
    );

    // Invalidate cache after update
    await MetricsService.invalidateCache(tenantId, 'slow_dead_stock');

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
 * Get slow-moving and dead stock items (cached)
 */
router.get('/slow-dead-stock', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      slowThresholdDays = 90,
      deadThresholdDays = 180,
    } = req.query;

    const results = await MetricsService.getSlowDeadStock(
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
 * Compute inventory turns and DOI for a time window (cached)
 */
router.get('/turns-doi', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd = new Date().toISOString(),
    } = req.query;

    const results = await MetricsService.getTurnsAndDOI(
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
 * Invalidates cache after computation
 */
router.post('/compute/turns-doi', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      windowEnd = new Date().toISOString(),
    } = req.body;

    const runId = await MetricsService.storeTurnsAndDoi(
      tenantId,
      new Date(windowStart),
      new Date(windowEnd)
    );

    // Invalidate cache after update
    await MetricsService.invalidateCache(tenantId, 'turns_doi');

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
 * Invalidates all caches after computation
 */
router.post('/compute/all', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
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

    // Invalidate all metrics cache
    await MetricsService.invalidateCache(tenantId);

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

/**
 * POST /metrics/cache/invalidate
 * Invalidate cached metrics for the current tenant
 * Optional metricType parameter to invalidate specific metric
 */
router.post('/cache/invalidate', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { metricType } = req.body;

    const deletedCount = await cacheAdapter.invalidate(tenantId, metricType);

    res.json({
      success: true,
      message: metricType 
        ? `Cache invalidated for metric: ${metricType}`
        : 'All cached metrics invalidated',
      deletedCount,
    });
  } catch (error) {
    console.error('Error invalidating cache:', error);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

/**
 * GET /metrics/cache/stats
 * Get cache statistics (backend type, connection status, entry counts)
 */
router.get('/cache/stats', async (req: Request, res: Response) => {
  try {
    const stats = await cacheAdapter.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('Error fetching cache stats:', error);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

export default router;
