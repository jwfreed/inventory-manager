import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_balance', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'RESTRICT' },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    uom: { type: 'text', notNull: true },
    on_hand: { type: 'numeric(18,6)', notNull: true, default: 0 },
    reserved: { type: 'numeric(18,6)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('inventory_balance', 'pk_inventory_balance', {
    primaryKey: ['tenant_id', 'item_id', 'location_id', 'uom']
  });

  pgm.createIndex('inventory_balance', ['tenant_id', 'item_id'], { name: 'idx_inventory_balance_tenant_item' });
  pgm.createIndex('inventory_balance', ['tenant_id', 'location_id'], { name: 'idx_inventory_balance_tenant_location' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_balance');
}
