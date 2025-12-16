import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_execution_lines', {
    id: { type: 'uuid', primaryKey: true },
    work_order_execution_id: {
      type: 'uuid',
      notNull: true,
      references: 'work_order_executions',
      onDelete: 'CASCADE'
    },
    line_type: { type: 'text', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    from_location_id: { type: 'uuid', references: 'locations' },
    to_location_id: { type: 'uuid', references: 'locations' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('work_order_execution_lines', 'chk_wo_exec_lines_locations', {
    check:
      "(line_type = 'consume' AND from_location_id IS NOT NULL AND to_location_id IS NULL)\n" +
      "OR (line_type = 'produce' AND to_location_id IS NOT NULL AND from_location_id IS NULL)"
  });

  pgm.addConstraint('work_order_execution_lines', 'chk_wo_exec_lines_type', {
    check: "line_type IN ('consume','produce')"
  });

  pgm.addConstraint('work_order_execution_lines', 'chk_wo_exec_lines_quantity', {
    check: 'quantity > 0'
  });

  pgm.createIndex('work_order_execution_lines', 'work_order_execution_id', {
    name: 'idx_wo_exec_lines_execution'
  });
  pgm.createIndex('work_order_execution_lines', 'item_id', {
    name: 'idx_wo_exec_lines_item'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_execution_lines');
}
