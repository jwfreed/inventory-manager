import { createHash } from 'crypto';
import type { PoolClient } from 'pg';

const IN_PROGRESS_STATUS = -1;

type IdempotencyError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

export type IdempotencyReplayResult<T = unknown> = {
  replayed: true;
  responseStatus: number;
  responseBody: T;
};

export type IdempotencyClaimResult<T = unknown> =
  | { replayed: false }
  | IdempotencyReplayResult<T>;

export type IdempotencyFinalizeResult<T = unknown> = {
  alreadyFinalized: boolean;
  responseStatus: number;
  responseBody: T;
};

function createIdempotencyError(code: string, details?: Record<string, unknown>): IdempotencyError {
  const error = new Error(code) as IdempotencyError;
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, normalizeJsonValue(entryValue)]);
    return Object.fromEntries(entries);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

export function canonicalizeTransactionalIdempotencyBody(body: unknown): unknown {
  return normalizeJsonValue(body ?? null);
}

export function hashTransactionalIdempotencyRequest(params: {
  method?: string;
  endpoint?: string;
  body: unknown;
  headers?: Record<string, unknown>;
}): string {
  const canonicalBody = canonicalizeTransactionalIdempotencyBody(params.body);
  return createHash('sha256').update(JSON.stringify(canonicalBody)).digest('hex');
}

async function assertIdempotencyTransaction(client: PoolClient, phase: 'claim' | 'finalize'): Promise<void> {
  const initial = await client.query<{ xid: string | null }>(
    `SELECT txid_current_if_assigned()::text AS xid`
  );
  if (initial.rows[0]?.xid) {
    return;
  }

  // Force XID assignment in the current transaction, then verify the same transaction remains active.
  await client.query(`SELECT txid_current()::text AS xid`);

  const verified = await client.query<{ xid: string | null }>(
    `SELECT txid_current_if_assigned()::text AS xid`
  );
  if (!verified.rows[0]?.xid) {
    throw createIdempotencyError('IDEMPOTENCY_REQUIRES_TRANSACTION', { phase });
  }
}

export async function claimTransactionalIdempotency<T = unknown>(
  client: PoolClient,
  params: {
    tenantId: string;
    key: string;
    endpoint: string;
    requestHash: string;
  }
): Promise<IdempotencyClaimResult<T>> {
  const key = params.key.trim();
  if (!key) {
    throw createIdempotencyError('IDEMPOTENCY_KEY_REQUIRED');
  }
  await assertIdempotencyTransaction(client, 'claim');

  const insertResult = await client.query(
    `INSERT INTO idempotency_keys (
        tenant_id,
        key,
        endpoint,
        request_hash,
        response_status,
        response_body,
        status,
        response_ref,
        updated_at,
        created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'IN_PROGRESS', NULL, now(), now())
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [
      params.tenantId,
      key,
      params.endpoint,
      params.requestHash,
      IN_PROGRESS_STATUS,
      JSON.stringify({ code: 'IDEMPOTENCY_IN_PROGRESS' })
    ]
  );

  const existingResult = await client.query<{
    endpoint: string;
    request_hash: string;
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT endpoint, request_hash, response_status, response_body
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2
      FOR UPDATE`,
    [params.tenantId, key]
  );

  if (existingResult.rowCount === 0) {
    throw createIdempotencyError('IDEMPOTENCY_KEY_MISSING', {
      tenantId: params.tenantId,
      key
    });
  }

  const row = existingResult.rows[0];
  if (row.endpoint !== params.endpoint) {
    throw createIdempotencyError('IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS', {
      tenantId: params.tenantId,
      key,
      expectedEndpoint: row.endpoint,
      receivedEndpoint: params.endpoint
    });
  }
  if (row.request_hash !== params.requestHash) {
    throw createIdempotencyError('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD', {
      reason: 'request_hash_mismatch',
      tenantId: params.tenantId,
      key
    });
  }

  if (row.response_status > IN_PROGRESS_STATUS) {
    return {
      replayed: true,
      responseStatus: row.response_status,
      responseBody: row.response_body as T
    };
  }

  if (insertResult.rowCount === 0) {
    throw createIdempotencyError('IDEMPOTENCY_REQUEST_IN_PROGRESS', {
      tenantId: params.tenantId,
      key,
      endpoint: params.endpoint
    });
  }

  return { replayed: false };
}

export async function finalizeTransactionalIdempotency(
  client: PoolClient,
  params: {
    tenantId: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
  }
): Promise<IdempotencyFinalizeResult> {
  const key = params.key.trim();
  if (!key) {
    throw createIdempotencyError('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!Number.isInteger(params.responseStatus)) {
    throw createIdempotencyError('IDEMPOTENCY_RESPONSE_STATUS_INVALID', {
      responseStatus: params.responseStatus
    });
  }
  await assertIdempotencyTransaction(client, 'finalize');

  const update = await client.query(
    `UPDATE idempotency_keys
        SET response_status = $3,
            response_body = $4::jsonb,
            status = 'SUCCEEDED',
            updated_at = now()
      WHERE tenant_id = $1
        AND key = $2
        AND response_status = $5`,
    [
      params.tenantId,
      key,
      params.responseStatus,
      JSON.stringify(params.responseBody ?? null),
      IN_PROGRESS_STATUS
    ]
  );

  if (update.rowCount === 1) {
    return {
      alreadyFinalized: false,
      responseStatus: params.responseStatus,
      responseBody: params.responseBody
    };
  }

  const existingResult = await client.query<{
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT response_status, response_body
       FROM idempotency_keys
      WHERE tenant_id = $1
        AND key = $2
      FOR UPDATE`,
    [params.tenantId, key]
  );
  if (existingResult.rowCount === 0) {
    throw createIdempotencyError('IDEMPOTENCY_MISSING_CLAIM', {
      tenantId: params.tenantId,
      key
    });
  }

  const existing = existingResult.rows[0];
  if (existing.response_status > IN_PROGRESS_STATUS) {
    return {
      alreadyFinalized: true,
      responseStatus: existing.response_status,
      responseBody: existing.response_body
    };
  }

  throw createIdempotencyError('IDEMPOTENCY_FINALIZE_CONFLICT', {
    tenantId: params.tenantId,
    key,
    responseStatus: existing.response_status
  });
}
