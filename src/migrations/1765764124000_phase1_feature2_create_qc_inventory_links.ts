import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('qc_inventory_links', {
    id: { type: 'uuid', primaryKey: true },
    qc_event_id: {
      type: 'uuid',
      notNull: true,
      references: 'qc_events',
      onDelete: 'CASCADE'
    },
    inventory_movement_id: { type: 'uuid', notNull: true, references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('qc_inventory_links', 'uq_qc_inventory_links_event', 'UNIQUE (qc_event_id)');
  pgm.createIndex('qc_inventory_links', 'inventory_movement_id', {
    name: 'idx_qc_inventory_links_movement_id'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('qc_inventory_links');
}
