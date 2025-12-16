import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('lots', {
    id: { type: 'uuid', primaryKey: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    lot_code: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    manufactured_at: { type: 'timestamptz' },
    received_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    vendor_lot_code: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('lots', 'chk_lots_status', {
    check: "status IN ('active','quarantine','blocked','consumed','expired')"
  });

  pgm.createIndex('lots', ['item_id', 'lot_code'], { name: 'idx_lots_item_code', unique: true });
  pgm.createIndex('lots', 'status', { name: 'idx_lots_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('lots');
}

