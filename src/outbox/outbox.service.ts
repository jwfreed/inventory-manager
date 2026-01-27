import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { pool } from '../db';

export type OutboxEventInput = {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
};

export type OutboxEventRow = {
  id: string;
  event_seq: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  attempts: number;
  available_at: string;
  locked_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export async function enqueueOutboxEvent(
  client: PoolClient,
  input: OutboxEventInput
): Promise<string> {
  const id = uuidv4();
  const payload = input.payload ?? {};
  const availableAt = input.availableAt ?? new Date();

  await client.query(
    `INSERT INTO outbox_events (
        id, tenant_id, aggregate_type, aggregate_id, event_type, payload, status, attempts,
        available_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, now(), now())
     ON CONFLICT (tenant_id, aggregate_type, aggregate_id, event_type) DO NOTHING`,
    [
      id,
      input.tenantId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      JSON.stringify(payload),
      availableAt
    ]
  );

  return id;
}

function computeBackoffMs(attempt: number): number {
  const base = Number(process.env.OUTBOX_RETRY_BASE_MS ?? 2000);
  const max = Number(process.env.OUTBOX_RETRY_MAX_MS ?? 60000);
  const jitter = Number(process.env.OUTBOX_RETRY_JITTER_MS ?? 1000);
  const exponential = Math.min(base * 2 ** Math.max(attempt - 1, 0), max);
  return exponential + Math.floor(Math.random() * jitter);
}

export async function withOutboxEventLock<T>(
  handler: (client: PoolClient, event: OutboxEventRow) => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<OutboxEventRow>(
      `SELECT *
         FROM outbox_events
        WHERE status IN ('pending', 'failed')
          AND available_at <= now()
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    if (res.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }

    const event = res.rows[0];
    await client.query(
      `UPDATE outbox_events
          SET status = 'processing',
              locked_at = now(),
              attempts = attempts + 1,
              updated_at = now()
        WHERE id = $1`,
      [event.id]
    );

    const result = await handler(client, event);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markOutboxEventComplete(client: PoolClient, eventId: string) {
  await client.query(
    `UPDATE outbox_events
        SET status = 'completed',
            processed_at = now(),
            locked_at = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [eventId]
  );
}

export async function markOutboxEventFailed(
  client: PoolClient,
  event: OutboxEventRow,
  error: Error
) {
  const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 8);
  const attempts = event.attempts + 1;

  if (attempts >= maxAttempts) {
    await client.query(
      `INSERT INTO outbox_dead_letters (
          id, outbox_event_id, tenant_id, aggregate_type, aggregate_id, event_type,
          payload, attempts, last_error, failed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        uuidv4(),
        event.id,
        event.tenant_id,
        event.aggregate_type,
        event.aggregate_id,
        event.event_type,
        event.payload ?? {},
        attempts,
        error.message
      ]
    );

    await client.query(
      `UPDATE outbox_events
          SET status = 'dead',
              processed_at = now(),
              locked_at = NULL,
              last_error = $2,
              updated_at = now()
        WHERE id = $1`,
      [event.id, error.message]
    );
    return;
  }

  const delayMs = computeBackoffMs(attempts);
  await client.query(
    `UPDATE outbox_events
        SET status = 'failed',
            available_at = now() + ($2::int || ' milliseconds')::interval,
            locked_at = NULL,
            last_error = $3,
            updated_at = now()
      WHERE id = $1`,
    [event.id, delayMs, error.message]
  );
}
