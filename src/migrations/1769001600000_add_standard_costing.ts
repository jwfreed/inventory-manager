import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add standard_cost to items table
  pgm.addColumn('items', {
    standard_cost: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Standard unit cost for inventory valuation. NULL if not yet costed.'
    }
  });

  pgm.addConstraint('items', 'chk_items_standard_cost_nonnegative', 'CHECK (standard_cost IS NULL OR standard_cost >= 0)');

  // Add unit_price to purchase_order_lines
  pgm.addColumn('purchase_order_lines', {
    unit_price: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Purchase price per unit. NULL if price not yet negotiated.'
    }
  });

  pgm.addConstraint('purchase_order_lines', 'chk_po_lines_unit_price_nonnegative', 'CHECK (unit_price IS NULL OR unit_price >= 0)');

  // Add unit_cost to purchase_order_receipt_lines for actual received cost
  pgm.addColumn('purchase_order_receipt_lines', {
    unit_cost: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Actual unit cost at time of receipt (typically matches PO line unit_price).'
    }
  });

  pgm.addConstraint('purchase_order_receipt_lines', 'chk_receipt_lines_unit_cost_nonnegative', 'CHECK (unit_cost IS NULL OR unit_cost >= 0)');

  // Add cost fields to inventory_movement_lines to track financial value of movements
  pgm.addColumn('inventory_movement_lines', {
    unit_cost: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Unit cost for this movement line (from item standard_cost at time of posting).'
    },
    extended_cost: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Total cost for this line (quantity_delta * unit_cost). Can be negative for issues.'
    }
  });

  pgm.createIndex('items', 'standard_cost', { 
    name: 'idx_items_standard_cost',
    where: 'standard_cost IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('inventory_movement_lines', ['unit_cost', 'extended_cost']);
  pgm.dropColumn('purchase_order_receipt_lines', 'unit_cost');
  pgm.dropColumn('purchase_order_lines', 'unit_price');
  pgm.dropColumn('items', 'standard_cost');
}
