import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_actions', {
    id: { type: 'uuid', primaryKey: true },
    recall_case_id: { type: 'uuid', notNull: true, references: 'recall_cases', onDelete: 'CASCADE' },
    action_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    lot_id: { type: 'uuid', references: 'lots' },
    sales_order_shipment_id: { type: 'uuid', references: 'sales_order_shipments' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('recall_actions', 'chk_recall_actions_type', {
    check:
      "action_type IN ('block_lot','quarantine_lot','scrap_lot','restock_lot','customer_notify')"
  });
  pgm.addConstraint('recall_actions', 'chk_recall_actions_status', {
    check: "status IN ('planned','in_progress','completed','canceled')"
  });

  pgm.createIndex('recall_actions', ['recall_case_id', 'status'], {
    name: 'idx_recall_actions_case_status'
  });
  pgm.createIndex('recall_actions', 'lot_id', { name: 'idx_recall_actions_lot' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_actions');
}

