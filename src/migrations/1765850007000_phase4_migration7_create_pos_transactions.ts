import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pos_transactions', {
    id: { type: 'uuid', primaryKey: true },
    pos_source_id: { type: 'uuid', notNull: true, references: 'pos_sources' },
    external_transaction_id: { type: 'text', notNull: true },
    transaction_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true },
    store_location_id: { type: 'uuid', references: 'locations' },
    currency: { type: 'text' },
    raw_payload: { type: 'jsonb' },
    notes: { type: 'text' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('pos_transactions', 'chk_pos_transactions_type', {
    check: "transaction_type IN ('sale','return','void')"
  });
  pgm.addConstraint('pos_transactions', 'chk_pos_transactions_status', {
    check: "status IN ('ingested','posted','rejected')"
  });

  pgm.createIndex('pos_transactions', ['pos_source_id', 'external_transaction_id'], {
    name: 'idx_pos_transactions_source_ext',
    unique: true
  });
  pgm.createIndex('pos_transactions', ['status', 'occurred_at'], { name: 'idx_pos_transactions_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pos_transactions');
}

