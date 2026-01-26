import type { MigrationBuilder } from 'node-pg-migrate';

const OUTBOX_STATUS = "('pending','processing','completed','failed','dead')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('outbox_events', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    aggregate_type: { type: 'text', notNull: true },
    aggregate_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: pgm.func(`'{}'::jsonb`) },
    status: { type: 'text', notNull: true, default: 'pending' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    locked_at: { type: 'timestamptz' },
    processed_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('outbox_events', 'chk_outbox_status', {
    check: `status IN ${OUTBOX_STATUS}`
  });

  pgm.addConstraint('outbox_events', 'uq_outbox_event_identity', {
    unique: ['tenant_id', 'aggregate_type', 'aggregate_id', 'event_type']
  });

  pgm.createIndex('outbox_events', ['status', 'available_at'], { name: 'idx_outbox_status_available' });
  pgm.createIndex('outbox_events', ['tenant_id', 'aggregate_type', 'aggregate_id'], { name: 'idx_outbox_aggregate' });
  pgm.createIndex('outbox_events', ['created_at'], { name: 'idx_outbox_created_at' });

  pgm.createTable('outbox_dead_letters', {
    id: { type: 'uuid', primaryKey: true },
    outbox_event_id: { type: 'uuid', notNull: true, references: 'outbox_events', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true },
    aggregate_type: { type: 'text', notNull: true },
    aggregate_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    attempts: { type: 'integer', notNull: true },
    last_error: { type: 'text' },
    failed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('outbox_dead_letters', ['tenant_id', 'event_type'], { name: 'idx_outbox_dead_letters_tenant_event' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('outbox_dead_letters');
  pgm.dropTable('outbox_events');
}
