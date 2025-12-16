import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pick_tasks', {
    id: { type: 'uuid', primaryKey: true },
    pick_batch_id: { type: 'uuid', notNull: true, references: 'pick_batches', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true },
    inventory_reservation_id: { type: 'uuid', references: 'inventory_reservations' },
    sales_order_line_id: { type: 'uuid', references: 'sales_order_lines' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    from_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    quantity_requested: { type: 'numeric(18,6)', notNull: true },
    quantity_picked: { type: 'numeric(18,6)' },
    picked_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('pick_tasks', 'chk_pick_tasks_status', {
    check: "status IN ('pending','picked','short','canceled')"
  });

  pgm.createIndex('pick_tasks', ['pick_batch_id', 'status'], { name: 'idx_pick_tasks_batch_status' });
  pgm.createIndex('pick_tasks', 'inventory_reservation_id', { name: 'idx_pick_tasks_reservation' });
  pgm.createIndex('pick_tasks', 'sales_order_line_id', { name: 'idx_pick_tasks_sales_order_line' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pick_tasks');
}

