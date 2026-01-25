import { Router, type Request, type Response } from 'express';
import { query, pool } from '../db';
import { withTimeout } from '../lib/timeouts';
import { cacheAdapter } from '../lib/redis';

const router = Router();

const READY_TIMEOUT_MS = Number(process.env.HEALTH_READY_TIMEOUT_MS || 2000);
const DB_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS || 1500);
const REDIS_TIMEOUT_MS = Number(process.env.HEALTH_REDIS_TIMEOUT_MS || 1000);
const REQUIRED_SCHEMA_VERSION = process.env.REQUIRED_SCHEMA_VERSION;

router.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/health/ready', async (_req: Request, res: Response) => {
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

  // Schema check (soft if REQUIRED_SCHEMA_VERSION is not set)
  try {
    const result = await withTimeout(
      query(
        'SELECT MAX(id) AS max_id FROM inventory_schema_migrations'
      ),
      DB_TIMEOUT_MS,
      'migrations'
    );
    const maxId = result.rows[0]?.max_id ?? null;
    details.migrations = { ok: true, maxId, required: REQUIRED_SCHEMA_VERSION ?? null };
    if (REQUIRED_SCHEMA_VERSION && maxId && String(maxId) !== String(REQUIRED_SCHEMA_VERSION)) {
      details.migrations = { ok: false, maxId, required: REQUIRED_SCHEMA_VERSION };
      ready = false;
    }
  } catch (error) {
    details.migrations = { ok: false, error: (error as Error).message };
    if (REQUIRED_SCHEMA_VERSION) {
      ready = false;
    }
  }

  // Soft dependency: Redis
  try {
    const stats = await withTimeout(cacheAdapter.getStats(), REDIS_TIMEOUT_MS, 'redis');
    details.redis = { ok: true, ...stats };
  } catch (error) {
    details.redis = { ok: false, error: (error as Error).message };
  }

  const durationMs = Date.now() - start;
  details.durationMs = durationMs;
  details.pool = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  };

  const response = {
    status: ready ? 'ok' : 'not_ready',
    ready,
    timestamp: new Date().toISOString(),
    details
  };

  res.status(ready ? 200 : 503).json(response);
});

export default router;
