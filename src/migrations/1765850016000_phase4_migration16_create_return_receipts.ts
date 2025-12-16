import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_receipts', {
    id: { type: 'uuid', primaryKey: true },
    return_authorization_id: { type: 'uuid', notNull: true, references: 'return_authorizations' },
    status: { type: 'text', notNull: true },
    received_at: { type: 'timestamptz', notNull: true },
    received_to_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    external_ref: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('return_receipts', 'chk_return_receipts_status', {
    check: "status IN ('draft','posted','canceled')"
  });

  pgm.createIndex('return_receipts', 'inventory_movement_id', {
    name: 'idx_return_receipts_movement',
    unique: true,
    where: 'inventory_movement_id IS NOT NULL'
  });
  pgm.createIndex('return_receipts', ['return_authorization_id', 'received_at'], {
    name: 'idx_return_receipts_rma'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_receipts');
}

