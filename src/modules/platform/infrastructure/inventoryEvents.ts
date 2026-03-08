import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { pool } from '../../../db';
import { enqueueOutboxEvent } from '../../../outbox/outbox.service';
import { validateInventoryEventRegistryInput } from '../application/inventoryEventRegistry';

export type InventoryEventDispatch = false | {
  aggregateType?: string;
  aggregateId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
};

export type InventoryEventInput = {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload?: Record<string, unknown>;
  producerIdempotencyKey?: string | null;
  dispatch?: InventoryEventDispatch;
};

export type InventoryEventRow = {
  event_seq: string;
  event_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown> | null;
  created_at: string;
  producer_idempotency_key: string | null;
};

export async function getNextInventoryEventVersion(
  client: PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string
): Promise<number> {
  const result = await client.query<{ next_version: string | number }>(
    `SELECT COALESCE(MAX(event_version), 0) + 1 AS next_version
       FROM inventory_events
      WHERE tenant_id = $1
        AND aggregate_type = $2
        AND aggregate_id = $3`,
    [tenantId, aggregateType, aggregateId]
  );
  return Number(result.rows[0]?.next_version ?? 1);
}

export async function appendInventoryEvent(
  client: PoolClient,
  input: InventoryEventInput
): Promise<string> {
  if (!Number.isInteger(input.eventVersion) || input.eventVersion <= 0) {
    throw new Error('INVENTORY_EVENT_VERSION_INVALID');
  }
  validateInventoryEventRegistryInput(input);

  const eventId = uuidv4();
  await client.query(
    `INSERT INTO inventory_events (
        event_id,
        tenant_id,
        aggregate_type,
        aggregate_id,
        event_type,
        event_version,
        payload,
        created_at,
        producer_idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), $8)`,
    [
      eventId,
      input.tenantId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.eventVersion,
      JSON.stringify(input.payload ?? {}),
      input.producerIdempotencyKey ?? null
    ]
  );
  return eventId;
}

export async function appendInventoryEventWithDispatch(
  client: PoolClient,
  input: InventoryEventInput
): Promise<string> {
  const eventId = await appendInventoryEvent(client, input);
  if (input.dispatch === false) {
    return eventId;
  }

  const dispatch = input.dispatch ?? {};
  await enqueueOutboxEvent(client, {
    tenantId: input.tenantId,
    aggregateType: dispatch.aggregateType ?? input.aggregateType,
    aggregateId: dispatch.aggregateId ?? input.aggregateId,
    eventType: dispatch.eventType ?? input.eventType,
    payload: dispatch.payload ?? input.payload,
    availableAt: dispatch.availableAt
  });

  return eventId;
}

export async function appendInventoryEventsWithDispatch(
  client: PoolClient,
  inputs: InventoryEventInput[]
): Promise<void> {
  const orderedInputs = [...inputs].sort((left, right) => {
    const aggregateType = left.aggregateType.localeCompare(right.aggregateType);
    if (aggregateType !== 0) return aggregateType;
    const aggregateId = left.aggregateId.localeCompare(right.aggregateId);
    if (aggregateId !== 0) return aggregateId;
    if (left.eventVersion !== right.eventVersion) {
      return left.eventVersion - right.eventVersion;
    }
    return left.eventType.localeCompare(right.eventType);
  });
  for (const input of orderedInputs) {
    await appendInventoryEventWithDispatch(client, input);
  }
}

export async function processInventoryEventBatch<T>(
  consumerName: string,
  handler: (client: PoolClient, event: InventoryEventRow) => Promise<T>,
  maxBatchSize?: number
): Promise<number> {
  const limit = maxBatchSize ?? Number(process.env.OUTBOX_BATCH_SIZE ?? 25);
  let processed = 0;

  while (processed < limit) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO inventory_event_consumers (consumer_name, last_event_seq, updated_at)
         VALUES ($1, 0, now())
         ON CONFLICT (consumer_name) DO NOTHING`,
        [consumerName]
      );
      const cursorRes = await client.query<{ last_event_seq: string }>(
        `SELECT last_event_seq
           FROM inventory_event_consumers
          WHERE consumer_name = $1
          FOR UPDATE`,
        [consumerName]
      );
      const lastEventSeq = cursorRes.rows[0]?.last_event_seq ?? '0';
      const eventRes = await client.query<InventoryEventRow>(
        `SELECT event_seq, event_id, tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload, created_at, producer_idempotency_key
           FROM inventory_events
          WHERE event_seq > $1::bigint
          ORDER BY event_seq ASC
          LIMIT 1`,
        [lastEventSeq]
      );

      if (eventRes.rowCount === 0) {
        await client.query('COMMIT');
        return processed;
      }

      const event = eventRes.rows[0];
      await handler(client, event);
      await client.query(
        `UPDATE inventory_event_consumers
            SET last_event_seq = $2,
                updated_at = now()
          WHERE consumer_name = $1`,
        [consumerName, event.event_seq]
      );
      await client.query('COMMIT');
      processed += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return processed;
}
