import type { MigrationBuilder } from 'node-pg-migrate';

const LPN_STATUS_VALUES = "('active','consumed','shipped','damaged','quarantine','expired')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create license_plates table for LPN tracking
  pgm.createTable('license_plates', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    lpn: { type: 'text', notNull: true, comment: 'License Plate Number - unique identifier for the container/pallet' },
    status: { type: 'text', notNull: true, default: "'active'", comment: 'Current status of the LPN' },
    item_id: { type: 'uuid', notNull: true, comment: 'Item contained in this LPN' },
    lot_id: { type: 'uuid', comment: 'Lot/batch number if applicable' },
    location_id: { type: 'uuid', notNull: true, comment: 'Current storage location' },
    parent_lpn_id: { type: 'uuid', comment: 'Parent LPN for nested containers (e.g., case on pallet)' },
    quantity: { type: 'numeric(18,6)', notNull: true, default: 0, comment: 'Current quantity in this LPN' },
    uom: { type: 'text', notNull: true, comment: 'Unit of measure for the quantity' },
    container_type: { type: 'text', comment: 'Type of container: pallet, case, bin, tote, etc.' },
    received_at: { type: 'timestamptz', comment: 'When this LPN was first received' },
    expiration_date: { type: 'date', comment: 'Expiration date for perishable items' },
    purchase_order_receipt_id: { type: 'uuid', comment: 'Source PO receipt if received via PO' },
    production_date: { type: 'date', comment: 'Production/manufacturing date' },
    notes: { type: 'text', comment: 'Additional notes or tracking information' },
    metadata: { type: 'jsonb', comment: 'Additional flexible attributes (dimensions, weight, etc.)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // Indexes for performance
  pgm.createIndex('license_plates', 'tenant_id', { name: 'idx_license_plates_tenant' });
  pgm.createIndex('license_plates', ['tenant_id', 'lpn'], { 
    name: 'idx_license_plates_tenant_lpn',
    unique: true 
  });
  pgm.createIndex('license_plates', 'item_id', { name: 'idx_license_plates_item' });
  pgm.createIndex('license_plates', 'lot_id', { name: 'idx_license_plates_lot', where: 'lot_id IS NOT NULL' });
  pgm.createIndex('license_plates', 'location_id', { name: 'idx_license_plates_location' });
  pgm.createIndex('license_plates', 'parent_lpn_id', { name: 'idx_license_plates_parent', where: 'parent_lpn_id IS NOT NULL' });
  pgm.createIndex('license_plates', 'status', { name: 'idx_license_plates_status' });
  pgm.createIndex('license_plates', 'purchase_order_receipt_id', { 
    name: 'idx_license_plates_po_receipt',
    where: 'purchase_order_receipt_id IS NOT NULL' 
  });

  // Constraints
  pgm.addConstraint('license_plates', 'chk_license_plates_status', `CHECK (status IN ${LPN_STATUS_VALUES})`);
  pgm.addConstraint('license_plates', 'chk_license_plates_quantity_nonnegative', 'CHECK (quantity >= 0)');
  pgm.addConstraint('license_plates', 'chk_license_plates_lpn_not_empty', 'CHECK (LENGTH(TRIM(lpn)) > 0)');

  // Foreign keys
  pgm.addConstraint('license_plates', 'fk_license_plates_tenant', {
    foreignKeys: {
      columns: 'tenant_id',
      references: 'tenants(id)',
      onDelete: 'CASCADE'
    }
  });

  pgm.addConstraint('license_plates', 'fk_license_plates_item', {
    foreignKeys: {
      columns: 'item_id',
      references: 'items(id)',
      onDelete: 'RESTRICT'
    }
  });

  pgm.addConstraint('license_plates', 'fk_license_plates_lot', {
    foreignKeys: {
      columns: 'lot_id',
      references: 'lots(id)',
      onDelete: 'RESTRICT'
    }
  });

  pgm.addConstraint('license_plates', 'fk_license_plates_location', {
    foreignKeys: {
      columns: 'location_id',
      references: 'locations(id)',
      onDelete: 'RESTRICT'
    }
  });

  pgm.addConstraint('license_plates', 'fk_license_plates_parent', {
    foreignKeys: {
      columns: 'parent_lpn_id',
      references: 'license_plates(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.addConstraint('license_plates', 'fk_license_plates_po_receipt', {
    foreignKeys: {
      columns: 'purchase_order_receipt_id',
      references: 'purchase_order_receipts(id)',
      onDelete: 'SET NULL'
    }
  });

  // Create inventory_movement_lpns linking table
  // This tracks which LPNs were involved in each movement
  pgm.createTable('inventory_movement_lpns', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    inventory_movement_line_id: { type: 'uuid', notNull: true },
    license_plate_id: { type: 'uuid', notNull: true },
    quantity_delta: { type: 'numeric(18,6)', notNull: true, comment: 'Quantity change for this LPN in this movement' },
    uom: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('inventory_movement_lpns', 'tenant_id', { name: 'idx_inventory_movement_lpns_tenant' });
  pgm.createIndex('inventory_movement_lpns', 'inventory_movement_line_id', { 
    name: 'idx_inventory_movement_lpns_line' 
  });
  pgm.createIndex('inventory_movement_lpns', 'license_plate_id', { 
    name: 'idx_inventory_movement_lpns_lpn' 
  });

  pgm.addConstraint('inventory_movement_lpns', 'chk_inventory_movement_lpns_qty', 'CHECK (quantity_delta <> 0)');

  pgm.addConstraint('inventory_movement_lpns', 'fk_inventory_movement_lpns_tenant', {
    foreignKeys: {
      columns: 'tenant_id',
      references: 'tenants(id)',
      onDelete: 'CASCADE'
    }
  });

  pgm.addConstraint('inventory_movement_lpns', 'fk_inventory_movement_lpns_line', {
    foreignKeys: {
      columns: 'inventory_movement_line_id',
      references: 'inventory_movement_lines(id)',
      onDelete: 'CASCADE'
    }
  });

  pgm.addConstraint('inventory_movement_lpns', 'fk_inventory_movement_lpns_lpn', {
    foreignKeys: {
      columns: 'license_plate_id',
      references: 'license_plates(id)',
      onDelete: 'RESTRICT'
    }
  });

  // Create materialized view for current inventory levels by LPN
  // This provides fast queries for current inventory position
  pgm.createMaterializedView(
    'inventory_levels_by_lpn',
    {},
    `SELECT 
      lp.tenant_id,
      lp.id AS license_plate_id,
      lp.lpn,
      lp.item_id,
      lp.lot_id,
      lp.location_id,
      lp.status,
      lp.container_type,
      lp.quantity,
      lp.uom,
      lp.expiration_date,
      lp.received_at,
      lp.parent_lpn_id,
      i.sku AS item_sku,
      i.name AS item_name,
      l.code AS location_code,
      l.name AS location_name,
      lot.lot_number,
      lp.updated_at
    FROM license_plates lp
    INNER JOIN items i ON i.id = lp.item_id
    INNER JOIN locations l ON l.id = lp.location_id
    LEFT JOIN lots lot ON lot.id = lp.lot_id
    WHERE lp.quantity > 0 AND lp.status = 'active'`
  );

  pgm.createIndex('inventory_levels_by_lpn', 'tenant_id', { name: 'idx_inv_levels_lpn_tenant' });
  pgm.createIndex('inventory_levels_by_lpn', 'license_plate_id', { name: 'idx_inv_levels_lpn_lpn' });
  pgm.createIndex('inventory_levels_by_lpn', 'item_id', { name: 'idx_inv_levels_lpn_item' });
  pgm.createIndex('inventory_levels_by_lpn', 'location_id', { name: 'idx_inv_levels_lpn_location' });
  pgm.createIndex('inventory_levels_by_lpn', 'lot_id', { name: 'idx_inv_levels_lpn_lot', where: 'lot_id IS NOT NULL' });

  // Create standard inventory_levels view (without LPN detail) for compatibility
  pgm.createView(
    'inventory_levels',
    {},
    `SELECT 
      tenant_id,
      item_id,
      location_id,
      lot_id,
      uom,
      SUM(quantity) AS quantity_on_hand,
      COUNT(DISTINCT license_plate_id) AS lpn_count,
      MIN(received_at) AS earliest_received,
      MAX(received_at) AS latest_received,
      MIN(expiration_date) AS earliest_expiration
    FROM inventory_levels_by_lpn
    GROUP BY tenant_id, item_id, location_id, lot_id, uom`
  );

  // Function to refresh the materialized view
  pgm.createFunction(
    'refresh_inventory_levels_by_lpn',
    [],
    {
      returns: 'void',
      language: 'plpgsql',
      replace: true
    },
    `BEGIN
      REFRESH MATERIALIZED VIEW CONCURRENTLY inventory_levels_by_lpn;
    END;`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropFunction('refresh_inventory_levels_by_lpn', []);
  pgm.dropView('inventory_levels');
  pgm.dropMaterializedView('inventory_levels_by_lpn');
  pgm.dropTable('inventory_movement_lpns');
  pgm.dropTable('license_plates');
}
