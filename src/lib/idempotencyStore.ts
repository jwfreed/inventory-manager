import { createHash } from 'crypto';
import { query } from '../db';

export type IdempotencyStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';

export type IdempotencyRecord = {
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseRef: string | null;
  isNew?: boolean; // true if this is a new insert, false if existing record
};

export function hashRequestBody(body: unknown): string {
  const payload = JSON.stringify(body ?? {});
  return createHash('sha256').update(payload).digest('hex');
}

export async function beginIdempotency(key: string, requestHash: string): Promise<IdempotencyRecord> {
  try {
    const insert = await query<{
      key: string;
      request_hash: string;
      status: IdempotencyStatus;
      response_ref: string | null;
    }>(
      `INSERT INTO idempotency_keys (key, request_hash, status, created_at, updated_at)
       VALUES ($1, $2, 'IN_PROGRESS', now(), now())
       RETURNING key, request_hash, status, response_ref`,
      [key, requestHash]
    );
    const row = insert.rows[0];
    return {
      key: row.key,
      requestHash: row.request_hash,
      status: row.status,
      responseRef: row.response_ref,
      isNew: true
    };
  } catch (err: any) {
    if (err?.code !== '23505') {
      throw err;
    }
  }

  const existing = await query<{
    key: string;
    request_hash: string;
    status: IdempotencyStatus;
    response_ref: string | null;
  }>(
    `SELECT key, request_hash, status, response_ref
       FROM idempotency_keys
      WHERE key = $1`,
    [key]
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error('IDEMPOTENCY_KEY_MISSING');
  }
  if (row.request_hash !== requestHash) {
    const error = new Error('IDEMPOTENCY_HASH_MISMATCH') as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  if (row.status === 'FAILED') {
    const retry = await query(
      `UPDATE idempotency_keys
          SET status = 'IN_PROGRESS',
              updated_at = now()
        WHERE key = $1
        RETURNING key, request_hash, status, response_ref`,
      [key]
    );
    const updated = retry.rows[0];
    return {
      key: updated.key,
      requestHash: updated.request_hash,
      status: updated.status,
      responseRef: updated.response_ref,
      isNew: true // Treating failed-then-retried as new
    };
  }
  return {
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    responseRef: row.response_ref,
    isNew: false
  };
}

export async function completeIdempotency(
  key: string,
  status: IdempotencyStatus,
  responseRef: string | null
): Promise<void> {
  await query(
    `UPDATE idempotency_keys
        SET status = $2,
            response_ref = $3,
            updated_at = now()
      WHERE key = $1`,
    [key, status, responseRef]
  );
}
