import { Router, Request, Response } from 'express';
import { MetricsService } from '../services/metrics.service';
import { requireAuth } from '../middleware/auth.middleware';
import { cacheAdapter } from '../lib/redis';
import { triggerJob } from '../jobs/scheduler';
import { getJobStatus } from '../jobs/metricsRecalculation.job';

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

    const { runId, updatedCount } = await MetricsService.storeAbcClassificationKpis(
      tenantId,
      windowDays,
      { notes: 'Manual KPI run: ABC classification', asOf: new Date() }
    );
    
    // Invalidate cache after update
    await MetricsService.invalidateCache(tenantId, 'abc_classification');

    res.json({
      success: true,
      message: `ABC classification computed for ${updatedCount} items`,
      updatedCount,
      runId,
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

    const { runId, updatedCount } = await MetricsService.storeSlowDeadStockKpis(
      tenantId,
      slowThresholdDays,
      deadThresholdDays,
      { notes: 'Manual KPI run: slow/dead stock', asOf: new Date() }
    );

    // Invalidate cache after update
    await MetricsService.invalidateCache(tenantId, 'slow_dead_stock');

    res.json({
      success: true,
      message: `Slow/dead stock flags updated for ${updatedCount} items`,
      updatedCount,
      runId,
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
      new Date(windowEnd),
      { notes: 'Manual KPI run: turns/DOI', asOf: new Date() }
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

    const runId = await MetricsService.startKpiRun(tenantId, {
      windowStart: new Date(turnsWindowStart),
      windowEnd: new Date(turnsWindowEnd),
      notes: 'Manual KPI run: compute all',
      asOf: new Date(),
    });

    // Compute ABC classification
    results.abcUpdated = (await MetricsService.storeAbcClassificationKpis(
      tenantId,
      abcWindowDays,
      { runId, finalizeRun: false }
    )).updatedCount;

    // Compute slow/dead stock
    results.slowDeadUpdated = (await MetricsService.storeSlowDeadStockKpis(
      tenantId,
      slowThresholdDays,
      deadThresholdDays,
      { runId, finalizeRun: false }
    )).updatedCount;

    // Compute and store turns/DOI
    results.turnsDoiRunId = await MetricsService.storeTurnsAndDoi(
      tenantId,
      new Date(turnsWindowStart),
      new Date(turnsWindowEnd),
      { runId, finalizeRun: false }
    );

    await MetricsService.finalizeKpiRun(runId);

    // Invalidate all metrics cache
    await MetricsService.invalidateCache(tenantId);

    res.json({
      success: true,
      message: 'All metrics computed successfully',
      results: { ...results, runId },
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

/**
 * GET /metrics/job/status
 * Get nightly metrics recalculation job status
 */
router.get('/job/status', async (req: Request, res: Response) => {
  try {
    const status = getJobStatus();

    res.json({
      success: true,
      job: 'metrics-recalculation',
      schedule: '02:00 UTC daily',
      ...status,
    });
  } catch (error) {
    console.error('Error fetching job status:', error);
    res.status(500).json({ error: 'Failed to fetch job status' });
  }
});

/**
 * POST /metrics/job/trigger
 * Manually trigger the nightly metrics recalculation job
 * (Admin/testing only - normally runs automatically at 02:00 UTC)
 */
router.post('/job/trigger', async (req: Request, res: Response) => {
  try {
    // Trigger the job asynchronously (don't wait for completion)
    triggerJob('metrics-recalculation').catch(err => {
      console.error('Background job execution failed:', err);
    });

    res.json({
      success: true,
      message: 'Metrics recalculation job triggered',
      note: 'Job is running in the background. Check /metrics/job/status for progress.',
    });
  } catch (error) {
    console.error('Error triggering job:', error);
    res.status(500).json({ error: 'Failed to trigger job' });
  }
});

export default router;
