import { Router, type Request, type Response } from 'express';
import { query, pool } from '../db';
import { withTimeout } from '../lib/timeouts';
import { cacheAdapter } from '../lib/redis';
import { getInventoryInvariantJobStatus } from '../jobs/inventoryInvariants.job';

const router = Router();

const READY_TIMEOUT_MS = Number(process.env.HEALTH_READY_TIMEOUT_MS || 2000);
const DB_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS || 1500);
const REDIS_TIMEOUT_MS = Number(process.env.HEALTH_REDIS_TIMEOUT_MS || 1000);
const REQUIRED_SCHEMA_VERSION = process.env.REQUIRED_SCHEMA_VERSION;
const HEALTH_INCLUDE_REDIS_IN_HEALTHZ = String(process.env.HEALTH_INCLUDE_REDIS_IN_HEALTHZ ?? '').trim().toLowerCase() === 'true';

async function evaluateReadiness(options: { includeRedis: boolean }) {
  const start = Date.now();
  const details: Record<string, unknown> = {};
  let ready = true;

  try {
    await withTimeout(query('SELECT 1'), DB_TIMEOUT_MS, 'db');
    details.db = { ok: true };
  } catch (error) {
    details.db = { ok: false, error: (error as Error).message };
    ready = false;
  }

  // Migration state is required for truthful readiness, especially in CI/test.
  try {
    const result = await withTimeout(
      query('SELECT MAX(id) AS max_id FROM inventory_schema_migrations'),
      DB_TIMEOUT_MS,
      'migrations'
    );
    const maxId = result.rows[0]?.max_id ?? null;
    details.migrations = { ok: true, maxId, required: REQUIRED_SCHEMA_VERSION ?? null };
    if (REQUIRED_SCHEMA_VERSION && String(maxId) !== String(REQUIRED_SCHEMA_VERSION)) {
      details.migrations = { ok: false, maxId, required: REQUIRED_SCHEMA_VERSION };
      ready = false;
    }
  } catch (error) {
    details.migrations = { ok: false, error: (error as Error).message };
    ready = false;
  }

  if (options.includeRedis) {
    try {
      const stats = await withTimeout(cacheAdapter.getStats(), REDIS_TIMEOUT_MS, 'redis');
      details.redis = { ok: true, ...stats };
    } catch (error) {
      details.redis = { ok: false, error: (error as Error).message };
    }
  }

  const invariantsStatus = getInventoryInvariantJobStatus();
  details.invariants = {
    ok: invariantsStatus.lastRunOk === true,
    running: invariantsStatus.isRunning,
    lastRunOk: invariantsStatus.lastRunOk,
    lastRunTime: invariantsStatus.lastRunTime,
    lastRunDuration: invariantsStatus.lastRunDuration,
    lastRunError: invariantsStatus.lastRunError,
    failureCount: Array.isArray(invariantsStatus.lastRunFailures)
      ? invariantsStatus.lastRunFailures.length
      : 0,
    lastRunFailures: invariantsStatus.lastRunFailures
  };

  details.durationMs = Date.now() - start;
  details.pool = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  };

  return {
    ready,
    details,
    timestamp: new Date().toISOString()
  };
}

router.get('/healthz', async (_req: Request, res: Response) => {
  const result = await withTimeout(
    evaluateReadiness({ includeRedis: HEALTH_INCLUDE_REDIS_IN_HEALTHZ }),
    READY_TIMEOUT_MS,
    'healthz'
  ).catch((error) => ({
    ready: false,
    details: { error: (error as Error).message },
    timestamp: new Date().toISOString()
  }));

  res.status(result.ready ? 200 : 503).json({
    ok: result.ready,
    status: result.ready ? 'ok' : 'not_ready',
    ready: result.ready,
    timestamp: result.timestamp,
    details: result.details
  });
});

router.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/health/ready', async (_req: Request, res: Response) => {
  const result = await withTimeout(
    evaluateReadiness({ includeRedis: true }),
    READY_TIMEOUT_MS,
    'health.ready'
  ).catch((error) => ({
    ready: false,
    details: { error: (error as Error).message },
    timestamp: new Date().toISOString()
  }));

  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? 'ok' : 'not_ready',
    ready: result.ready,
    timestamp: result.timestamp,
    details: result.details
  });
});

export default router;
