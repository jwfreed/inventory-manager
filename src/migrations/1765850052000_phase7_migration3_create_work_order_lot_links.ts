import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_lot_links', {
    id: { type: 'uuid', primaryKey: true },
    work_order_execution_id: {
      type: 'uuid',
      notNull: true,
      references: 'work_order_executions',
      onDelete: 'CASCADE'
    },
    inventory_movement_lot_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movement_lots',
      onDelete: 'CASCADE'
    },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('work_order_lot_links', 'chk_work_order_lot_links_role', {
    check: "role IN ('consume','produce')"
  });

  pgm.createIndex('work_order_lot_links', 'work_order_execution_id', {
    name: 'idx_work_order_lot_links_execution'
  });
  pgm.createIndex('work_order_lot_links', 'inventory_movement_lot_id', {
    name: 'idx_work_order_lot_links_lot'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_lot_links');
}

