import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_gross_requirements', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    period_start: { type: 'date', notNull: true },
    source_type: { type: 'text', notNull: true },
    source_ref: { type: 'text' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('drp_gross_requirements', 'chk_drp_gross_req_type', {
    check: "source_type IN ('forecast','sales_orders','dependent')"
  });
  pgm.addConstraint('drp_gross_requirements', 'chk_drp_gross_req_quantity', {
    check: 'quantity >= 0'
  });

  pgm.createIndex(
    'drp_gross_requirements',
    ['drp_run_id', 'to_node_id', 'item_id', 'period_start'],
    { name: 'idx_drp_gross_req_run_node_item_period' }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_gross_requirements');
}

