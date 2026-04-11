import type { PoolClient } from 'pg';
import { withTransactionRetry } from '../../../db';

/**
 * Explicit transaction boundary for multi-step inventory operations that must
 * be atomic but are not themselves a single inventory command.
 *
 * Provides SERIALIZABLE isolation and retry semantics identical to runInventoryCommand.
 * Use this when an operation requires an explicit client to be shared across
 * multiple steps (e.g., transfer + audit log) that must commit together.
 *
 * Callers own responsibility for idempotency and lock acquisition within fn.
 */
export async function withInventoryTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withTransactionRetry(fn, { isolationLevel: 'SERIALIZABLE', retries: 2 });
}
