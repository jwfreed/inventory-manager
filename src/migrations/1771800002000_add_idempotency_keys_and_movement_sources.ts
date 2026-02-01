import type { MigrationBuilder } from 'node-pg-migrate';

const IDEMPOTENCY_STATUS_VALUES = "('IN_PROGRESS','SUCCEEDED','FAILED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', primaryKey: true },
    request_hash: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    response_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('idempotency_keys', 'chk_idempotency_status', {
    check: `status IN ${IDEMPOTENCY_STATUS_VALUES}`
  });

  pgm.addColumn('inventory_movements', {
    source_type: { type: 'text' },
    source_id: { type: 'text' }
  });

  pgm.createIndex('inventory_movements', ['tenant_id', 'source_type', 'source_id', 'movement_type'], {
    name: 'uq_inventory_movements_source',
    unique: true,
    where: 'source_type IS NOT NULL AND source_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movements', 'uq_inventory_movements_source', { ifExists: true });
  pgm.dropColumns('inventory_movements', ['source_type', 'source_id']);
  pgm.dropConstraint('idempotency_keys', 'chk_idempotency_status', { ifExists: true });
  pgm.dropTable('idempotency_keys');
}
