import type { MigrationBuilder } from 'node-pg-migrate';

const TABLES = [
  'drp_scheduled_receipts',
  'mps_supply_inputs',
  'mrp_scheduled_receipts',
  'pos_transaction_lines',
  'pos_transactions',
  'pos_sources',
  'shipment_lot_links',
  'work_order_lot_links',
];

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('BEGIN');
  for (const table of TABLES) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }
  pgm.sql('COMMIT');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('BEGIN');

  pgm.createTable('drp_scheduled_receipts', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    period_start: { type: 'date', notNull: true },
    source_type: { type: 'text', notNull: true },
    source_ref: { type: 'text' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('drp_scheduled_receipts', 'chk_drp_sched_receipts_type', {
    check: "source_type IN ('planned_transfers','purchase_orders','work_orders')",
  });
  pgm.addConstraint('drp_scheduled_receipts', 'chk_drp_sched_receipts_quantity', {
    check: 'quantity >= 0',
  });
  pgm.createIndex(
    'drp_scheduled_receipts',
    ['drp_run_id', 'to_node_id', 'item_id', 'period_start'],
    { name: 'idx_drp_sched_receipts_run_node_item_period' }
  );

  pgm.createTable('mps_supply_inputs', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_item_id: { type: 'uuid', notNull: true, references: 'mps_plan_items', onDelete: 'CASCADE' },
    mps_period_id: { type: 'uuid', notNull: true, references: 'mps_periods', onDelete: 'CASCADE' },
    supply_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('mps_supply_inputs', 'unique_mps_supply_scope', {
    unique: ['mps_plan_item_id', 'mps_period_id', 'supply_type'],
  });
  pgm.addConstraint('mps_supply_inputs', 'chk_mps_supply_type', {
    check: "supply_type IN ('work_orders')",
  });
  pgm.addConstraint('mps_supply_inputs', 'chk_mps_supply_quantity', {
    check: 'quantity >= 0',
  });

  pgm.createTable('mrp_scheduled_receipts', {
    id: { type: 'uuid', primaryKey: true },
    mrp_run_id: { type: 'uuid', notNull: true, references: 'mrp_runs', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    period_start: { type: 'date', notNull: true },
    source_type: { type: 'text', notNull: true },
    source_ref: { type: 'text' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('mrp_scheduled_receipts', 'chk_mrp_sched_receipts_type', {
    check: "source_type IN ('purchase_orders','work_orders','planned_transfers')",
  });
  pgm.addConstraint('mrp_scheduled_receipts', 'chk_mrp_sched_receipts_quantity', {
    check: 'quantity >= 0',
  });
  pgm.createIndex('mrp_scheduled_receipts', ['mrp_run_id', 'item_id', 'period_start'], {
    name: 'idx_mrp_sched_receipts_run_item_period',
  });

  pgm.createTable('pos_sources', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('pos_sources', 'active', { name: 'idx_pos_sources_active' });

  pgm.createTable('pos_transactions', {
    id: { type: 'uuid', primaryKey: true },
    pos_source_id: { type: 'uuid', notNull: true, references: 'pos_sources' },
    external_transaction_id: { type: 'text', notNull: true },
    transaction_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true },
    store_location_id: { type: 'uuid', references: 'locations' },
    currency: { type: 'text' },
    raw_payload: { type: 'jsonb' },
    notes: { type: 'text' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true },
  });
  pgm.addConstraint('pos_transactions', 'chk_pos_transactions_type', {
    check: "transaction_type IN ('sale','return','void')",
  });
  pgm.addConstraint('pos_transactions', 'chk_pos_transactions_status', {
    check: "status IN ('ingested','posted','rejected')",
  });
  pgm.createIndex('pos_transactions', ['pos_source_id', 'external_transaction_id'], {
    name: 'idx_pos_transactions_source_ext',
    unique: true,
  });
  pgm.createIndex('pos_transactions', ['status', 'occurred_at'], { name: 'idx_pos_transactions_status' });

  pgm.createTable('pos_transaction_lines', {
    id: { type: 'uuid', primaryKey: true },
    pos_transaction_id: { type: 'uuid', notNull: true, references: 'pos_transactions', onDelete: 'CASCADE' },
    line_number: { type: 'integer', notNull: true },
    external_line_id: { type: 'text' },
    external_sku: { type: 'text' },
    item_id: { type: 'uuid', references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('pos_transaction_lines', 'pos_transaction_lines_line_unique', {
    unique: ['pos_transaction_id', 'line_number'],
  });
  pgm.addConstraint('pos_transaction_lines', 'chk_pos_transaction_lines_qty', {
    check: 'quantity > 0',
  });
  pgm.createIndex('pos_transaction_lines', 'item_id', { name: 'idx_pos_transaction_lines_item' });
  pgm.createIndex('pos_transaction_lines', 'external_sku', { name: 'idx_pos_transaction_lines_external_sku' });

  pgm.createTable('shipment_lot_links', {
    id: { type: 'uuid', primaryKey: true },
    sales_order_shipment_id: {
      type: 'uuid',
      notNull: true,
      references: 'sales_order_shipments',
      onDelete: 'CASCADE',
    },
    inventory_movement_lot_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movement_lots',
      onDelete: 'CASCADE',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('shipment_lot_links', 'sales_order_shipment_id', {
    name: 'idx_shipment_lot_links_shipment',
  });
  pgm.createIndex('shipment_lot_links', 'inventory_movement_lot_id', {
    name: 'idx_shipment_lot_links_lot',
  });

  pgm.createTable('work_order_lot_links', {
    id: { type: 'uuid', primaryKey: true },
    work_order_execution_id: {
      type: 'uuid',
      notNull: true,
      references: 'work_order_executions',
      onDelete: 'CASCADE',
    },
    inventory_movement_lot_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movement_lots',
      onDelete: 'CASCADE',
    },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('work_order_lot_links', 'chk_work_order_lot_links_role', {
    check: "role IN ('consume','produce')",
  });
  pgm.createIndex('work_order_lot_links', 'work_order_execution_id', {
    name: 'idx_work_order_lot_links_execution',
  });
  pgm.createIndex('work_order_lot_links', 'inventory_movement_lot_id', {
    name: 'idx_work_order_lot_links_lot',
  });

  pgm.sql('COMMIT');
}
