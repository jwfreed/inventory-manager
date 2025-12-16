import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mrp_gross_requirements', {
    id: { type: 'uuid', primaryKey: true },
    mrp_run_id: { type: 'uuid', notNull: true, references: 'mrp_runs', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    period_start: { type: 'date', notNull: true },
    source_type: { type: 'text', notNull: true },
    source_ref: { type: 'text' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_type', {
    check: "source_type IN ('mps','bom_explosion')"
  });
  pgm.addConstraint('mrp_gross_requirements', 'chk_mrp_gross_req_quantity', {
    check: 'quantity >= 0'
  });

  pgm.createIndex('mrp_gross_requirements', ['mrp_run_id', 'item_id', 'period_start'], {
    name: 'idx_mrp_gross_req_run_item_period'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mrp_gross_requirements');
}

