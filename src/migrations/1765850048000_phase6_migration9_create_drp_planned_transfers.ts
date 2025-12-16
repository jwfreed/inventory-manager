import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_planned_transfers', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    from_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    release_date: { type: 'date', notNull: true },
    receipt_date: { type: 'date', notNull: true },
    lane_id: { type: 'uuid', references: 'drp_lanes' },
    source_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('drp_planned_transfers', 'chk_drp_planned_transfers_nodes', {
    check: 'from_node_id <> to_node_id'
  });
  pgm.addConstraint('drp_planned_transfers', 'chk_drp_planned_transfers_quantity', {
    check: 'quantity > 0'
  });
  pgm.addConstraint('drp_planned_transfers', 'chk_drp_planned_transfers_dates', {
    check: 'release_date <= receipt_date'
  });

  pgm.createIndex('drp_planned_transfers', ['drp_run_id', 'release_date'], {
    name: 'idx_drp_planned_transfers_run_release'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_planned_transfers');
}

