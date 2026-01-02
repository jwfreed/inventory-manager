import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add average_cost to items table for moving average cost calculation
  pgm.addColumn('items', {
    average_cost: { 
      type: 'numeric(18,6)', 
      notNull: false,
      comment: 'Moving average unit cost for inventory valuation. Updated on each receipt. NULL if no receipts yet.'
    }
  });

  pgm.addConstraint('items', 'chk_items_average_cost_nonnegative', 'CHECK (average_cost IS NULL OR average_cost >= 0)');

  pgm.createIndex('items', 'average_cost', { 
    name: 'idx_items_average_cost',
    where: 'average_cost IS NOT NULL'
  });

  // Add quantity_on_hand to items for moving average calculation
  // This tracks the current on-hand quantity to calculate weighted average
  pgm.addColumn('items', {
    quantity_on_hand: { 
      type: 'numeric(18,6)', 
      notNull: false,
      default: 0,
      comment: 'Current on-hand quantity for moving average cost calculation. Updated on inventory movements.'
    }
  });

  pgm.addConstraint('items', 'chk_items_quantity_on_hand_nonnegative', 'CHECK (quantity_on_hand >= 0)');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('items', ['average_cost', 'quantity_on_hand']);
}
