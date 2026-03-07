import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS inventory_events (
      event_seq bigserial UNIQUE,
      event_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      aggregate_type text NOT NULL,
      aggregate_id uuid NOT NULL,
      event_type text NOT NULL,
      event_version integer NOT NULL CHECK (event_version > 0),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      producer_idempotency_key text NULL
    );
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_events_stream_version
      ON inventory_events (tenant_id, aggregate_type, aggregate_id, event_version);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_seq
      ON inventory_events (tenant_id, event_seq);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_aggregate_seq
      ON inventory_events (tenant_id, aggregate_type, aggregate_id, event_seq);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_type_created
      ON inventory_events (tenant_id, event_type, created_at);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_inventory_events_producer_key
      ON inventory_events (tenant_id, producer_idempotency_key)
      WHERE producer_idempotency_key IS NOT NULL;
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS inventory_event_consumers (
      consumer_name text PRIMARY KEY,
      last_event_seq bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // No-op by design. Append-only inventory event history should not be rolled back.
}
