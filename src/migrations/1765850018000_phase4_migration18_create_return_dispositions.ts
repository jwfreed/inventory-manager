import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_dispositions', {
    id: { type: 'uuid', primaryKey: true },
    return_receipt_id: { type: 'uuid', notNull: true, references: 'return_receipts' },
    status: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true },
    disposition_type: { type: 'text', notNull: true },
    from_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    to_location_id: { type: 'uuid', references: 'locations' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('return_dispositions', 'chk_return_dispositions_status', {
    check: "status IN ('draft','posted','canceled')"
  });
  pgm.addConstraint('return_dispositions', 'chk_return_dispositions_type', {
    check: "disposition_type IN ('restock','scrap','quarantine_hold')"
  });

  pgm.createIndex('return_dispositions', 'inventory_movement_id', {
    name: 'idx_return_dispositions_movement',
    unique: true,
    where: 'inventory_movement_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_dispositions');
}

