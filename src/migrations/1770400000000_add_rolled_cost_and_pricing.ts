import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add rolled-up cost fields for BOM-based costing
  pgm.addColumn('items', {
    rolled_cost: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Calculated cost based on BOM component costs. NULL if not yet calculated or not a manufactured item.'
    },
    rolled_cost_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'Timestamp when rolled_cost was last calculated. Used to detect stale costs.'
    },
    cost_method: {
      type: 'text',
      notNull: false,
      comment: "Costing method for this item: 'standard' (manual), 'rolled' (BOM-based), 'avg' (moving average)."
    }
  });

  pgm.addConstraint('items', 'chk_items_rolled_cost_nonnegative', 'CHECK (rolled_cost IS NULL OR rolled_cost >= 0)');
  pgm.addConstraint('items', 'chk_items_cost_method', "CHECK (cost_method IS NULL OR cost_method IN ('standard', 'rolled', 'avg'))");

  // Add selling price fields for customer-facing pricing
  pgm.addColumn('items', {
    selling_price: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Base selling price per unit. NULL if not sold or price not set.'
    },
    list_price: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'List/MSRP price per unit. NULL if not applicable.'
    },
    price_currency: {
      type: 'text',
      notNull: false,
      default: "'USD'",
      comment: 'Currency code (ISO 4217) for selling_price and list_price. Defaults to USD.'
    }
  });

  pgm.addConstraint('items', 'chk_items_selling_price_nonnegative', 'CHECK (selling_price IS NULL OR selling_price >= 0)');
  pgm.addConstraint('items', 'chk_items_list_price_nonnegative', 'CHECK (list_price IS NULL OR list_price >= 0)');

  // Add index for items with rolled costs
  pgm.createIndex('items', 'rolled_cost', {
    name: 'idx_items_rolled_cost',
    where: 'rolled_cost IS NOT NULL'
  });

  // Add index for items with selling prices
  pgm.createIndex('items', 'selling_price', {
    name: 'idx_items_selling_price',
    where: 'selling_price IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('items', [], { name: 'idx_items_selling_price' });
  pgm.dropIndex('items', [], { name: 'idx_items_rolled_cost' });
  pgm.dropConstraint('items', 'chk_items_list_price_nonnegative');
  pgm.dropConstraint('items', 'chk_items_selling_price_nonnegative');
  pgm.dropConstraint('items', 'chk_items_cost_method');
  pgm.dropConstraint('items', 'chk_items_rolled_cost_nonnegative');
  pgm.dropColumn('items', ['rolled_cost', 'rolled_cost_at', 'cost_method', 'selling_price', 'list_price', 'price_currency']);
}
