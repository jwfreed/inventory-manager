import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_executions', {
    id: { type: 'uuid', primaryKey: true },
    work_order_id: { type: 'uuid', notNull: true, references: 'work_orders' },
    occurred_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true },
    consumption_movement_id: { type: 'uuid', references: 'inventory_movements' },
    production_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('work_order_executions', 'chk_work_order_executions_status', {
    check: "status IN ('draft','posted','canceled')"
  });

  pgm.createIndex('work_order_executions', ['work_order_id', 'occurred_at'], {
    name: 'idx_work_order_executions_work_order'
  });

  pgm.createIndex('work_order_executions', 'consumption_movement_id', {
    name: 'idx_work_order_executions_consumption',
    unique: true,
    where: 'consumption_movement_id IS NOT NULL'
  });

  pgm.createIndex('work_order_executions', 'production_movement_id', {
    name: 'idx_work_order_executions_production',
    unique: true,
    where: 'production_movement_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_executions');
}
