import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_reservations', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    demand_type: { type: 'text', notNull: true },
    demand_id: { type: 'uuid', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    uom: { type: 'text', notNull: true },
    quantity_reserved: { type: 'numeric(18,6)', notNull: true },
    quantity_fulfilled: { type: 'numeric(18,6)' },
    reserved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    released_at: { type: 'timestamptz' },
    release_reason_code: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('inventory_reservations', 'inventory_reservations_unique', {
    unique: ['demand_type', 'demand_id', 'item_id', 'location_id', 'uom']
  });

  pgm.addConstraint('inventory_reservations', 'chk_reservation_status', {
    check: "status IN ('open','released','fulfilled','canceled')"
  });
  pgm.addConstraint('inventory_reservations', 'chk_reservation_demand_type', {
    check: "demand_type IN ('sales_order_line')"
  });
  pgm.addConstraint('inventory_reservations', 'chk_reservation_quantities', {
    check: 'quantity_reserved > 0 AND (quantity_fulfilled IS NULL OR quantity_fulfilled >= 0)'
  });

  pgm.createIndex('inventory_reservations', ['item_id', 'location_id', 'uom'], { name: 'idx_reservations_item_location' });
  pgm.createIndex('inventory_reservations', ['demand_type', 'demand_id'], { name: 'idx_reservations_demand' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_reservations');
}

