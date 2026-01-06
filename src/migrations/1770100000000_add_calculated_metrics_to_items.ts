import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add calculated metrics columns to items table
  pgm.addColumns('items', {
    abc_class: {
      type: 'text',
      notNull: false,
      comment: 'ABC classification based on movement velocity/value (A=high, B=medium, C=low)',
    },
    abc_computed_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'Timestamp when ABC classification was last computed',
    },
    is_slow_moving: {
      type: 'boolean',
      notNull: false,
      default: false,
      comment: 'Flag indicating item has low movement frequency below threshold',
    },
    is_dead_stock: {
      type: 'boolean',
      notNull: false,
      default: false,
      comment: 'Flag indicating item has zero movements in threshold period',
    },
    slow_dead_computed_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'Timestamp when slow/dead stock flags were last computed',
    },
  });

  // Add check constraint for abc_class values
  pgm.addConstraint('items', 'items_abc_class_check', {
    check: "abc_class IS NULL OR abc_class IN ('A', 'B', 'C')",
  });

  // Add index for filtering by ABC class
  pgm.createIndex('items', 'abc_class', {
    where: 'abc_class IS NOT NULL',
  });

  // Add index for filtering slow/dead stock
  pgm.createIndex('items', ['is_slow_moving', 'is_dead_stock'], {
    where: 'is_slow_moving = true OR is_dead_stock = true',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('items', ['is_slow_moving', 'is_dead_stock']);
  pgm.dropIndex('items', 'abc_class');
  pgm.dropConstraint('items', 'items_abc_class_check');
  pgm.dropColumns('items', [
    'abc_class',
    'abc_computed_at',
    'is_slow_moving',
    'is_dead_stock',
    'slow_dead_computed_at',
  ]);
}
