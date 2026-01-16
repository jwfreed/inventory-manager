import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_backorders', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants' },
    status: { type: 'text', notNull: true },
    demand_type: { type: 'text', notNull: true },
    demand_id: { type: 'uuid', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    uom: { type: 'text', notNull: true },
    quantity_backordered: { type: 'numeric(18,6)', notNull: true },
    backordered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('inventory_backorders', 'inventory_backorders_unique', {
    unique: ['tenant_id', 'demand_type', 'demand_id', 'item_id', 'location_id', 'uom']
  });

  pgm.addConstraint('inventory_backorders', 'chk_backorder_status', {
    check: "status IN ('open','fulfilled','canceled')"
  });
  pgm.addConstraint('inventory_backorders', 'chk_backorder_demand_type', {
    check: "demand_type IN ('sales_order_line')"
  });
  pgm.addConstraint('inventory_backorders', 'chk_backorder_quantity', {
    check: 'quantity_backordered > 0'
  });

  pgm.createIndex('inventory_backorders', ['tenant_id', 'item_id', 'location_id', 'uom'], {
    name: 'idx_backorders_item_location'
  });
  pgm.createIndex('inventory_backorders', ['tenant_id', 'demand_type', 'demand_id'], {
    name: 'idx_backorders_demand'
  });
  pgm.createIndex('inventory_backorders', ['tenant_id', 'status'], {
    name: 'idx_backorders_status'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_backorders');
}
