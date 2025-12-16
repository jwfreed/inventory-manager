import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pack_lines', {
    id: { type: 'uuid', primaryKey: true },
    pack_id: { type: 'uuid', notNull: true, references: 'packs', onDelete: 'CASCADE' },
    pick_task_id: { type: 'uuid', references: 'pick_tasks' },
    sales_order_line_id: { type: 'uuid', notNull: true, references: 'sales_order_lines' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_packed: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('pack_lines', 'chk_pack_lines_qty', {
    check: 'quantity_packed > 0'
  });

  pgm.createIndex('pack_lines', 'pack_id', { name: 'idx_pack_lines_pack' });
  pgm.createIndex('pack_lines', 'sales_order_line_id', { name: 'idx_pack_lines_so_line' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pack_lines');
}

