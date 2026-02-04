import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_balance_rebuild_audit', {
    id: { type: 'uuid', primaryKey: true },
    run_id: { type: 'uuid', notNull: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'RESTRICT' },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    uom: { type: 'text', notNull: true },
    before_qty: { type: 'numeric(18,6)', notNull: true },
    after_qty: { type: 'numeric(18,6)', notNull: true },
    delta_qty: { type: 'numeric(18,6)', notNull: true },
    actor: { type: 'text', notNull: true, default: 'system' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('inventory_balance_rebuild_audit', ['tenant_id', 'created_at'], {
    name: 'idx_balance_rebuild_audit_tenant_created'
  });
  pgm.createIndex('inventory_balance_rebuild_audit', ['run_id'], {
    name: 'idx_balance_rebuild_audit_run'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_balance_rebuild_audit');
}
