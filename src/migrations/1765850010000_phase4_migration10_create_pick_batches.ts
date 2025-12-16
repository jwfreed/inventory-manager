import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pick_batches', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    pick_type: { type: 'text', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('pick_batches', 'chk_pick_batches_status', {
    check: "status IN ('draft','released','in_progress','completed','canceled')"
  });
  pgm.addConstraint('pick_batches', 'chk_pick_batches_type', {
    check: "pick_type IN ('single_order','batch')"
  });

  pgm.createIndex('pick_batches', 'status', { name: 'idx_pick_batches_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pick_batches');
}

