import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_impacted_shipments', {
    id: { type: 'uuid', primaryKey: true },
    recall_trace_run_id: {
      type: 'uuid',
      notNull: true,
      references: 'recall_trace_runs',
      onDelete: 'CASCADE'
    },
    sales_order_shipment_id: { type: 'uuid', notNull: true, references: 'sales_order_shipments' },
    customer_id: { type: 'uuid', notNull: true, references: 'customers' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('recall_impacted_shipments', 'unique_trace_shipment', {
    unique: ['recall_trace_run_id', 'sales_order_shipment_id']
  });

  pgm.createIndex('recall_impacted_shipments', 'customer_id', {
    name: 'idx_recall_impacted_shipments_customer'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_impacted_shipments');
}

