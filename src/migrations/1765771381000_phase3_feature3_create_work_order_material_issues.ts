import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_material_issues', {
    id: { type: 'uuid', primaryKey: true },
    work_order_id: { type: 'uuid', notNull: true, references: 'work_orders' },
    status: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('work_order_material_issues', 'chk_womi_status', {
    check: "status IN ('draft','posted','canceled')"
  });

  pgm.createIndex('work_order_material_issues', 'inventory_movement_id', {
    name: 'idx_womi_movement',
    unique: true,
    where: 'inventory_movement_id IS NOT NULL'
  });

  pgm.createIndex('work_order_material_issues', ['work_order_id', 'occurred_at'], {
    name: 'idx_womi_work_order'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_material_issues');
}
