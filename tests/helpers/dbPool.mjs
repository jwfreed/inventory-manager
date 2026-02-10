/**
 * Helper: dbPool
 * Purpose: Provide a shared pg.Pool for db/ops tests that need SQL access.
 * Preconditions: DATABASE_URL is set.
 * Postconditions: Returns a singleton Pool; closeDbPool() ends it.
 * Consumers: tests/db and tests/ops only.
 * Common failures: missing DATABASE_URL or connection errors.
 */
import { Pool } from 'pg';

let sharedPool;

export function getDbPool() {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sharedPool;
}

export async function closeDbPool() {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
