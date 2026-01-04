import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Performance optimization indexes for frequently-queried columns.
 * These indexes speed up:
 * - ATP calculations (inventory_movement_lines by item/location)
 * - Reservation lookups
 * - Order filtering by customer/vendor and status
 * - Lot lookups by item
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // inventory_movement_lines - critical for ATP and inventory position calculations
  pgm.createIndex('inventory_movement_lines', ['tenant_id', 'item_id'], {
    name: 'idx_iml_tenant_item',
    ifNotExists: true,
  });
  pgm.createIndex('inventory_movement_lines', ['tenant_id', 'location_id'], {
    name: 'idx_iml_tenant_location',
    ifNotExists: true,
  });
  pgm.createIndex('inventory_movement_lines', ['movement_id'], {
    name: 'idx_iml_movement_id',
    ifNotExists: true,
  });

  // inventory_reservations - critical for ATP calculations
  pgm.createIndex('inventory_reservations', ['tenant_id', 'item_id', 'location_id', 'status'], {
    name: 'idx_reservations_tenant_item_loc_status',
    ifNotExists: true,
  });
  pgm.createIndex('inventory_reservations', ['tenant_id', 'status'], {
    name: 'idx_reservations_tenant_status',
    ifNotExists: true,
  });

  // sales_orders - customer and status filtering
  pgm.createIndex('sales_orders', ['tenant_id', 'customer_id'], {
    name: 'idx_sales_orders_tenant_customer',
    ifNotExists: true,
  });
  pgm.createIndex('sales_orders', ['tenant_id', 'status'], {
    name: 'idx_sales_orders_tenant_status',
    ifNotExists: true,
  });

  // purchase_orders - vendor and status filtering
  pgm.createIndex('purchase_orders', ['tenant_id', 'vendor_id'], {
    name: 'idx_purchase_orders_tenant_vendor',
    ifNotExists: true,
  });
  pgm.createIndex('purchase_orders', ['tenant_id', 'status'], {
    name: 'idx_purchase_orders_tenant_status',
    ifNotExists: true,
  });

  // lots - item and status lookups
  pgm.createIndex('lots', ['tenant_id', 'item_id'], {
    name: 'idx_lots_tenant_item',
    ifNotExists: true,
  });
  pgm.createIndex('lots', ['tenant_id', 'status'], {
    name: 'idx_lots_tenant_status',
    ifNotExists: true,
  });

  // items - lifecycle status filtering (common in dropdowns)
  pgm.createIndex('items', ['tenant_id', 'lifecycle_status'], {
    name: 'idx_items_tenant_lifecycle',
    ifNotExists: true,
  });

  // locations - active status filtering (common in dropdowns)
  pgm.createIndex('locations', ['tenant_id', 'active'], {
    name: 'idx_locations_tenant_active',
    ifNotExists: true,
  });

  // inventory_movements - status and type filtering
  pgm.createIndex('inventory_movements', ['tenant_id', 'status'], {
    name: 'idx_movements_tenant_status',
    ifNotExists: true,
  });

  // work_orders - status filtering
  pgm.createIndex('work_orders', ['tenant_id', 'status'], {
    name: 'idx_work_orders_tenant_status',
    ifNotExists: true,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movement_lines', [], { name: 'idx_iml_tenant_item', ifExists: true });
  pgm.dropIndex('inventory_movement_lines', [], { name: 'idx_iml_tenant_location', ifExists: true });
  pgm.dropIndex('inventory_movement_lines', [], { name: 'idx_iml_movement_id', ifExists: true });
  pgm.dropIndex('inventory_reservations', [], { name: 'idx_reservations_tenant_item_loc_status', ifExists: true });
  pgm.dropIndex('inventory_reservations', [], { name: 'idx_reservations_tenant_status', ifExists: true });
  pgm.dropIndex('sales_orders', [], { name: 'idx_sales_orders_tenant_customer', ifExists: true });
  pgm.dropIndex('sales_orders', [], { name: 'idx_sales_orders_tenant_status', ifExists: true });
  pgm.dropIndex('purchase_orders', [], { name: 'idx_purchase_orders_tenant_vendor', ifExists: true });
  pgm.dropIndex('purchase_orders', [], { name: 'idx_purchase_orders_tenant_status', ifExists: true });
  pgm.dropIndex('lots', [], { name: 'idx_lots_tenant_item', ifExists: true });
  pgm.dropIndex('lots', [], { name: 'idx_lots_tenant_status', ifExists: true });
  pgm.dropIndex('items', [], { name: 'idx_items_tenant_lifecycle', ifExists: true });
  pgm.dropIndex('locations', [], { name: 'idx_locations_tenant_active', ifExists: true });
  pgm.dropIndex('inventory_movements', [], { name: 'idx_movements_tenant_status', ifExists: true });
  pgm.dropIndex('work_orders', [], { name: 'idx_work_orders_tenant_status', ifExists: true });
}
