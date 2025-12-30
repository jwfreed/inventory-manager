import type { MigrationBuilder } from 'node-pg-migrate';

const WORK_ORDER_KIND_VALUES = "('production','disassembly')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('work_orders', {
    kind: { type: 'text', notNull: true, default: 'production' },
    related_work_order_id: { type: 'uuid', references: 'work_orders' }
  });

  pgm.addConstraint('work_orders', 'chk_work_orders_kind', {
    check: `kind IN ${WORK_ORDER_KIND_VALUES}`
  });

  pgm.createIndex('work_orders', 'kind', { name: 'idx_work_orders_kind' });

  pgm.alterColumn('work_orders', 'bom_id', { notNull: false });

  pgm.addColumn('work_order_material_issue_lines', {
    reason_code: { type: 'text' }
  });

  pgm.addColumn('work_order_execution_lines', {
    reason_code: { type: 'text' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('work_order_execution_lines', 'reason_code');
  pgm.dropColumn('work_order_material_issue_lines', 'reason_code');
  pgm.alterColumn('work_orders', 'bom_id', { notNull: true });
  pgm.dropIndex('work_orders', 'kind', { name: 'idx_work_orders_kind' });
  pgm.dropConstraint('work_orders', 'chk_work_orders_kind');
  pgm.dropColumn('work_orders', ['kind', 'related_work_order_id']);
}
