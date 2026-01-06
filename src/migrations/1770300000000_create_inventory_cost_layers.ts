import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create inventory_cost_layers table to track actual cost of inventory at different layers
  // This enables proper FIFO/LIFO/Average costing and accurate COGS calculation
  pgm.createTable('inventory_cost_layers', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'RESTRICT' },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    uom: { type: 'text', notNull: true },
    
    // Layer tracking
    layer_date: { 
      type: 'timestamptz', 
      notNull: true,
      comment: 'Date when this layer was created (receipt date, production date, etc.)'
    },
    layer_sequence: {
      type: 'integer',
      notNull: true,
      comment: 'Sequence number for layers created on same date (for FIFO ordering)'
    },
    
    // Quantity tracking
    original_quantity: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Original quantity when layer was created'
    },
    remaining_quantity: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Remaining quantity available in this layer (decreases as consumed)'
    },
    
    // Cost tracking
    unit_cost: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Unit cost for this layer (from receipt, production, etc.)'
    },
    extended_cost: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Total cost for remaining quantity (remaining_quantity * unit_cost)'
    },
    
    // Source tracking
    source_type: { 
      type: 'text', 
      notNull: true,
      comment: 'Type of source that created this layer: receipt, production, adjustment, opening_balance'
    },
    source_document_id: { 
      type: 'uuid',
      comment: 'ID of source document (receipt_line_id, work_order_id, adjustment_line_id, etc.)'
    },
    movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'SET NULL',
      comment: 'Movement that created this layer'
    },
    
    // Lot tracking (optional)
    lot_id: {
      type: 'uuid',
      references: 'lots',
      onDelete: 'RESTRICT',
      comment: 'Lot number if lot-tracked item'
    },
    
    // Metadata
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // Constraints
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_original_qty_positive', 
    'CHECK (original_quantity > 0)');
  
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_remaining_qty_nonnegative', 
    'CHECK (remaining_quantity >= 0)');
  
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_remaining_lte_original', 
    'CHECK (remaining_quantity <= original_quantity)');
  
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_unit_cost_nonnegative', 
    'CHECK (unit_cost >= 0)');
  
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_extended_cost_nonnegative', 
    'CHECK (extended_cost >= 0)');
  
  pgm.addConstraint('inventory_cost_layers', 'chk_cost_layers_source_type', 
    "CHECK (source_type IN ('receipt', 'production', 'adjustment', 'opening_balance', 'transfer_in'))");

  // Indexes for performance
  pgm.createIndex('inventory_cost_layers', 'tenant_id', { name: 'idx_cost_layers_tenant' });
  
  pgm.createIndex('inventory_cost_layers', ['tenant_id', 'item_id', 'location_id'], { 
    name: 'idx_cost_layers_item_location'
  });
  
  pgm.createIndex('inventory_cost_layers', ['tenant_id', 'item_id', 'location_id', 'layer_date', 'layer_sequence'], { 
    name: 'idx_cost_layers_fifo',
    where: 'remaining_quantity > 0'
  });
  
  pgm.createIndex('inventory_cost_layers', 'remaining_quantity', {
    name: 'idx_cost_layers_remaining',
    where: 'remaining_quantity > 0'
  });
  
  pgm.createIndex('inventory_cost_layers', 'movement_id', { 
    name: 'idx_cost_layers_movement',
    where: 'movement_id IS NOT NULL'
  });
  
  pgm.createIndex('inventory_cost_layers', 'lot_id', { 
    name: 'idx_cost_layers_lot',
    where: 'lot_id IS NOT NULL'
  });

  // Create cost_layer_consumptions table to track how layers are consumed
  pgm.createTable('cost_layer_consumptions', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    cost_layer_id: { type: 'uuid', notNull: true, references: 'inventory_cost_layers', onDelete: 'RESTRICT' },
    
    // Consumption details
    consumed_quantity: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Quantity consumed from this layer'
    },
    unit_cost: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Unit cost at time of consumption (from layer)'
    },
    extended_cost: { 
      type: 'numeric(18,6)', 
      notNull: true,
      comment: 'Total cost of consumption (consumed_quantity * unit_cost)'
    },
    
    // Source of consumption
    consumption_type: { 
      type: 'text', 
      notNull: true,
      comment: 'Type of consumption: issue, production_input, sale, adjustment, scrap, transfer_out'
    },
    consumption_document_id: { 
      type: 'uuid',
      comment: 'ID of consuming document (work_order_id, shipment_id, adjustment_line_id, etc.)'
    },
    movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'SET NULL',
      comment: 'Movement that consumed from this layer'
    },
    
    consumed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // Constraints
  pgm.addConstraint('cost_layer_consumptions', 'chk_consumptions_quantity_positive', 
    'CHECK (consumed_quantity > 0)');
  
  pgm.addConstraint('cost_layer_consumptions', 'chk_consumptions_unit_cost_nonnegative', 
    'CHECK (unit_cost >= 0)');
  
  pgm.addConstraint('cost_layer_consumptions', 'chk_consumptions_extended_cost_nonnegative', 
    'CHECK (extended_cost >= 0)');
  
  pgm.addConstraint('cost_layer_consumptions', 'chk_consumptions_type', 
    "CHECK (consumption_type IN ('issue', 'production_input', 'sale', 'adjustment', 'scrap', 'transfer_out'))");

  // Indexes
  pgm.createIndex('cost_layer_consumptions', 'tenant_id', { name: 'idx_consumptions_tenant' });
  
  pgm.createIndex('cost_layer_consumptions', 'cost_layer_id', { 
    name: 'idx_consumptions_layer'
  });
  
  pgm.createIndex('cost_layer_consumptions', 'movement_id', { 
    name: 'idx_consumptions_movement',
    where: 'movement_id IS NOT NULL'
  });
  
  pgm.createIndex('cost_layer_consumptions', 'consumed_at', { 
    name: 'idx_consumptions_date'
  });

  // Add comment explaining the cost layer system
  pgm.sql(`
    COMMENT ON TABLE inventory_cost_layers IS 
    'Tracks actual cost layers for inventory items. Each receipt/production creates a new layer with its actual cost.
     Layers are consumed in FIFO order (oldest first) to calculate accurate COGS.
     The remaining_quantity field tracks how much is left in each layer.
     When remaining_quantity reaches 0, the layer is fully consumed but retained for audit/reporting.';
  `);

  pgm.sql(`
    COMMENT ON TABLE cost_layer_consumptions IS 
    'Tracks the consumption history of cost layers. Records which layers were used for each issue/sale/consumption.
     Enables detailed COGS analysis and cost tracing from sale back to original receipt.';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('cost_layer_consumptions');
  pgm.dropTable('inventory_cost_layers');
}
