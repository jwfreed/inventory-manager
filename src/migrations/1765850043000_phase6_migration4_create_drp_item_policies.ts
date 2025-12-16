import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_item_policies', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    preferred_from_node_id: { type: 'uuid', references: 'drp_nodes' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    safety_stock_qty: { type: 'numeric(18,6)' },
    lot_sizing_method: { type: 'text', notNull: true },
    foq_qty: { type: 'numeric(18,6)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('drp_item_policies', 'unique_drp_item_policies_scope', {
    unique: ['drp_run_id', 'to_node_id', 'item_id', 'uom']
  });

  pgm.addConstraint('drp_item_policies', 'chk_drp_item_policies', {
    check:
      '(safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND ' +
      "lot_sizing_method IN ('l4l','foq') AND " +
      "(lot_sizing_method <> 'foq' OR foq_qty > 0)"
  });

  pgm.createIndex('drp_item_policies', ['drp_run_id', 'to_node_id'], {
    name: 'idx_drp_item_policies_run_node'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_item_policies');
}

