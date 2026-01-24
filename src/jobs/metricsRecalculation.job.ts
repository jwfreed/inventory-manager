import { query } from '../db';
import { MetricsService } from '../services/metrics.service';
import { emitEvent } from '../lib/events';

/**
 * In-memory job lock to prevent overlapping runs
 * For multi-instance deployments, use Redis-based locks (e.g., with bullmq)
 */
let isRunning = false;
let lastRunTime: Date | null = null;
let lastRunDuration: number | null = null;

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * Fetch all active tenants from the database
 */
async function getAllActiveTenants(): Promise<Tenant[]> {
  const result = await query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM tenants ORDER BY name'
  );

  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

/**
 * Nightly metrics recalculation job
 * 
 * Runs at 02:00 UTC daily
 * 
 * Tasks:
 * 1. Compute ABC classification for all tenants
 * 2. Compute slow/dead stock flags
 * 3. Compute turns and DOI for last 90 days
 * 4. Pre-warm cache with fresh results
 * 5. Emit SSE events to notify connected clients
 */
export async function recalculateMetrics(): Promise<void> {
  // Check job lock
  if (isRunning) {
    console.warn('⚠️  Metrics recalculation already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    console.log('📊 Starting nightly metrics recalculation');

    // Get all active tenants
    const tenants = await getAllActiveTenants();
    console.log(`   Processing ${tenants.length} tenant(s)`);

    if (tenants.length === 0) {
      console.log('   No tenants to process');
      return;
    }

    // Calculate time windows
    const now = new Date();
    const turnsWindowEnd = now;
    const turnsWindowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // 90 days ago

    // Process each tenant
    for (const tenant of tenants) {
      console.log(`\n   📈 Processing tenant: ${tenant.name} (${tenant.slug})`);
      
      try {
        const tenantStartTime = Date.now();

        const runId = await MetricsService.startKpiRun(tenant.id, {
          windowStart: turnsWindowStart,
          windowEnd: turnsWindowEnd,
          notes: 'Automatic KPI run: nightly metrics',
          asOf: now,
        });

        // 1. Compute ABC classification (also pre-warms cache via get method)
        console.log('      • Computing ABC classification...');
        const abcUpdated = (await MetricsService.storeAbcClassificationKpis(
          tenant.id,
          90,
          { runId, finalizeRun: false, notes: 'Automatic KPI run: ABC classification', asOf: now }
        )).updatedCount;
        
        // Pre-warm cache by calling get method
        await MetricsService.getABCClassification(tenant.id, 90);
        console.log(`      ✓ ABC: ${abcUpdated} items classified`);

        // 2. Compute slow/dead stock flags
        console.log('      • Computing slow/dead stock...');
        const slowDeadUpdated = (await MetricsService.storeSlowDeadStockKpis(
          tenant.id,
          90,
          180,
          { runId, finalizeRun: false, notes: 'Automatic KPI run: slow/dead stock', asOf: now }
        )).updatedCount;
        
        // Pre-warm cache
        await MetricsService.getSlowDeadStock(tenant.id, 90, 180);
        console.log(`      ✓ Slow/Dead: ${slowDeadUpdated} items flagged`);

        // 3. Compute and store turns/DOI
        console.log('      • Computing turns and DOI...');
        const turnsDoiRunId = await MetricsService.storeTurnsAndDoi(
          tenant.id,
          turnsWindowStart,
          turnsWindowEnd,
          { runId, finalizeRun: false, notes: 'Automatic KPI run: turns/DOI', asOf: now }
        );
        
        // Pre-warm cache
        await MetricsService.getTurnsAndDOI(tenant.id, turnsWindowStart, turnsWindowEnd);
        console.log(`      ✓ Turns/DOI: Run ${turnsDoiRunId}`);

        await MetricsService.finalizeKpiRun(runId);

        // 4. Pre-warm inventory aging cache
        console.log('      • Pre-warming inventory aging cache...');
        await MetricsService.getInventoryAging(tenant.id);
        console.log('      ✓ Inventory aging cached');

        const tenantDuration = Date.now() - tenantStartTime;
        console.log(`      ⏱️  Completed in ${tenantDuration}ms`);

        // 5. Emit SSE event to notify connected clients
        emitEvent(tenant.id, 'metrics:updated', {
          timestamp: new Date().toISOString(),
          metrics: ['abc_classification', 'slow_dead_stock', 'turns_doi', 'inventory_aging'],
        });

      } catch (error) {
        console.error(`      ❌ Failed to process tenant ${tenant.name}:`, error);
        // Continue with next tenant even if one fails
      }
    }

    lastRunTime = new Date();
    lastRunDuration = Date.now() - startTime;

    console.log(`\n✅ Metrics recalculation completed for ${tenants.length} tenant(s)`);
    console.log(`   Total duration: ${lastRunDuration}ms`);

  } catch (error) {
    console.error('❌ Metrics recalculation job failed:', error);
    throw error;
  } finally {
    isRunning = false;
  }
}

/**
 * Get job status (useful for monitoring/admin endpoints)
 */
export function getJobStatus() {
  return {
    isRunning,
    lastRunTime: lastRunTime?.toISOString() || null,
    lastRunDuration,
  };
}
