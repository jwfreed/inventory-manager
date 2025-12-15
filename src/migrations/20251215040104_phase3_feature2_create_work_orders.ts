import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_orders', {
    id: { type: 'uuid', primaryKey: true },
    work_order_number: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true },
    bom_id: { type: 'uuid', notNull: true, references: 'boms' },
    bom_version_id: { type: 'uuid', references: 'bom_versions' },
    output_item_id: { type: 'uuid', notNull: true, references: 'items' },
    output_uom: { type: 'text', notNull: true },
    quantity_planned: { type: 'numeric(18,6)', notNull: true },
    quantity_completed: { type: 'numeric(18,6)' },
    scheduled_start_at: { type: 'timestamptz' },
    scheduled_due_at: { type: 'timestamptz' },
    released_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('work_orders', 'chk_work_orders_status', {
    check: "status IN ('draft','released','in_progress','completed','canceled')"
  });

  pgm.addConstraint('work_orders', 'chk_work_orders_qty_planned', {
    check: 'quantity_planned > 0'
  });

  pgm.addConstraint('work_orders', 'chk_work_orders_qty_completed_nonneg', {
    check: 'quantity_completed IS NULL OR quantity_completed >= 0'
  });

  pgm.createIndex('work_orders', 'status', { name: 'idx_work_orders_status' });
  pgm.createIndex('work_orders', ['bom_id', 'bom_version_id'], { name: 'idx_work_orders_bom_version' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_orders');
}
