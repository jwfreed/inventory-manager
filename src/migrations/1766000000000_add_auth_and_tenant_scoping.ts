import type { MigrationBuilder } from 'node-pg-migrate';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_TENANT_NAME = 'Default Tenant';
const DEFAULT_TENANT_SLUG = 'default';

const TENANT_TABLES = [
  'audit_log',
  'bom_version_lines',
  'bom_versions',
  'boms',
  'customers',
  'cycle_count_lines',
  'cycle_counts',
  'drp_gross_requirements',
  'drp_item_policies',
  'drp_lanes',
  'drp_nodes',
  'drp_periods',
  'drp_plan_lines',
  'drp_planned_transfers',
  'drp_runs',
  'drp_scheduled_receipts',
  'inbound_closeouts',
  'inventory_adjustment_lines',
  'inventory_adjustments',
  'inventory_movement_lines',
  'inventory_movement_lots',
  'inventory_movements',
  'inventory_reservations',
  'items',
  'kpi_rollup_inputs',
  'kpi_runs',
  'kpi_snapshots',
  'locations',
  'lots',
  'mps_demand_inputs',
  'mps_periods',
  'mps_plan_items',
  'mps_plan_lines',
  'mps_plans',
  'mps_supply_inputs',
  'mrp_gross_requirements',
  'mrp_item_policies',
  'mrp_plan_lines',
  'mrp_planned_orders',
  'mrp_runs',
  'mrp_scheduled_receipts',
  'pack_lines',
  'packs',
  'pick_batches',
  'pick_tasks',
  'pos_sources',
  'pos_transaction_lines',
  'pos_transactions',
  'purchase_order_lines',
  'purchase_order_receipt_lines',
  'purchase_order_receipts',
  'purchase_orders',
  'putaway_lines',
  'putaways',
  'qc_events',
  'qc_inventory_links',
  'recall_actions',
  'recall_case_targets',
  'recall_cases',
  'recall_communications',
  'recall_impacted_lots',
  'recall_impacted_shipments',
  'recall_trace_runs',
  'replenishment_policies',
  'replenishment_recommendations',
  'return_authorization_lines',
  'return_authorizations',
  'return_disposition_lines',
  'return_dispositions',
  'return_receipt_lines',
  'return_receipts',
  'sales_order_lines',
  'sales_order_shipment_lines',
  'sales_order_shipments',
  'sales_orders',
  'shipment_lot_links',
  'vendors',
  'work_order_execution_lines',
  'work_order_executions',
  'work_order_lot_links',
  'work_order_material_issue_lines',
  'work_order_material_issues',
  'work_orders'
];

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    parent_tenant_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('tenants', 'fk_tenants_parent', {
    foreignKeys: {
      columns: 'parent_tenant_id',
      references: 'tenants(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.sql(
    `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
     VALUES ('${DEFAULT_TENANT_ID}', '${DEFAULT_TENANT_NAME}', '${DEFAULT_TENANT_SLUG}', NULL, now())
     ON CONFLICT (id) DO NOTHING`
  );

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('tenant_memberships', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'admin' },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('tenant_memberships', 'uq_tenant_membership', 'UNIQUE (tenant_id, user_id)');
  pgm.createIndex('tenant_memberships', ['user_id'], { name: 'idx_tenant_memberships_user' });

  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
    ip_address: { type: 'text' },
    user_agent: { type: 'text' }
  });

  pgm.createIndex('refresh_tokens', ['token_hash'], { name: 'idx_refresh_tokens_hash' });
  pgm.createIndex('refresh_tokens', ['user_id'], { name: 'idx_refresh_tokens_user' });
  pgm.createIndex('refresh_tokens', ['tenant_id'], { name: 'idx_refresh_tokens_tenant' });

  for (const table of TENANT_TABLES) {
    pgm.addColumn(table, {
      tenant_id: { type: 'uuid', notNull: true, default: DEFAULT_TENANT_ID }
    });
    pgm.alterColumn(table, 'tenant_id', { default: null });
    pgm.createIndex(table, ['tenant_id'], { name: `idx_${table}_tenant` });
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of TENANT_TABLES) {
    pgm.dropIndex(table, `idx_${table}_tenant`, { ifExists: true });
    pgm.dropColumn(table, 'tenant_id');
  }

  pgm.dropTable('refresh_tokens');
  pgm.dropTable('tenant_memberships');
  pgm.dropTable('users');
  pgm.dropTable('tenants');
}
