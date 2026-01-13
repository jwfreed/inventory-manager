import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('items', {
    uom_dimension: {
      type: 'text',
      comment: 'Dimension for canonical UOM (mass, volume, count, length, area, time)'
    },
    canonical_uom: {
      type: 'text',
      comment: 'Canonical UOM for this item (kg, L, each, m, m2, seconds)'
    },
    stocking_uom: {
      type: 'text',
      comment: 'Stocking/entry UOM for this item; must be convertible to canonical'
    }
  });

  pgm.addConstraint(
    'items',
    'chk_items_canonical_uom_dimension',
    `CHECK (
      (uom_dimension IS NULL AND canonical_uom IS NULL AND stocking_uom IS NULL)
      OR (
        uom_dimension IS NOT NULL
        AND canonical_uom IS NOT NULL
        AND stocking_uom IS NOT NULL
        AND (
          (uom_dimension = 'mass' AND canonical_uom = 'kg')
          OR (uom_dimension = 'volume' AND canonical_uom = 'L')
          OR (uom_dimension = 'count' AND canonical_uom = 'each')
          OR (uom_dimension = 'length' AND canonical_uom = 'm')
          OR (uom_dimension = 'area' AND canonical_uom = 'm2')
          OR (uom_dimension = 'time' AND canonical_uom = 'seconds')
        )
      )
    )`
  );

  pgm.addColumns('inventory_movement_lines', {
    quantity_delta_entered: {
      type: 'numeric(24,12)',
      comment: 'Entered quantity in original UOM (immutable metadata)'
    },
    uom_entered: {
      type: 'text',
      comment: 'Entered UOM (immutable metadata)'
    },
    quantity_delta_canonical: {
      type: 'numeric(24,12)',
      comment: 'Quantity delta in canonical UOM'
    },
    canonical_uom: {
      type: 'text',
      comment: 'Canonical UOM for this movement line'
    },
    uom_dimension: {
      type: 'text',
      comment: 'Dimension for canonical UOM'
    }
  });

  pgm.addConstraint(
    'inventory_movement_lines',
    'chk_movement_lines_canonical_fields',
    `CHECK (
      (quantity_delta_canonical IS NULL AND canonical_uom IS NULL AND uom_dimension IS NULL
       AND quantity_delta_entered IS NULL AND uom_entered IS NULL)
      OR (
        quantity_delta_canonical IS NOT NULL AND canonical_uom IS NOT NULL AND uom_dimension IS NOT NULL
        AND quantity_delta_entered IS NOT NULL AND uom_entered IS NOT NULL
        AND (
          (uom_dimension = 'mass' AND canonical_uom = 'kg')
          OR (uom_dimension = 'volume' AND canonical_uom = 'L')
          OR (uom_dimension = 'count' AND canonical_uom = 'each')
          OR (uom_dimension = 'length' AND canonical_uom = 'm')
          OR (uom_dimension = 'area' AND canonical_uom = 'm2')
          OR (uom_dimension = 'time' AND canonical_uom = 'seconds')
        )
      )
    )`
  );

  pgm.addColumns('bom_version_lines', {
    component_quantity_entered: {
      type: 'numeric(24,12)',
      comment: 'Entered component quantity in original UOM'
    },
    component_uom_entered: {
      type: 'text',
      comment: 'Entered component UOM'
    },
    component_quantity_canonical: {
      type: 'numeric(24,12)',
      comment: 'Component quantity in canonical UOM'
    },
    component_uom_canonical: {
      type: 'text',
      comment: 'Canonical UOM for this component'
    },
    component_uom_dimension: {
      type: 'text',
      comment: 'Dimension for component canonical UOM'
    }
  });

  pgm.addConstraint(
    'bom_version_lines',
    'chk_bom_lines_canonical_fields',
    `CHECK (
      (component_quantity_canonical IS NULL AND component_uom_canonical IS NULL AND component_uom_dimension IS NULL
       AND component_quantity_entered IS NULL AND component_uom_entered IS NULL)
      OR (
        component_quantity_canonical IS NOT NULL AND component_uom_canonical IS NOT NULL AND component_uom_dimension IS NOT NULL
        AND component_quantity_entered IS NOT NULL AND component_uom_entered IS NOT NULL
        AND (
          (component_uom_dimension = 'mass' AND component_uom_canonical = 'kg')
          OR (component_uom_dimension = 'volume' AND component_uom_canonical = 'L')
          OR (component_uom_dimension = 'count' AND component_uom_canonical = 'each')
          OR (component_uom_dimension = 'length' AND component_uom_canonical = 'm')
          OR (component_uom_dimension = 'area' AND component_uom_canonical = 'm2')
          OR (component_uom_dimension = 'time' AND component_uom_canonical = 'seconds')
        )
      )
    )`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('bom_version_lines', 'chk_bom_lines_canonical_fields', { ifExists: true });
  pgm.dropColumns('bom_version_lines', [
    'component_quantity_entered',
    'component_uom_entered',
    'component_quantity_canonical',
    'component_uom_canonical',
    'component_uom_dimension'
  ]);

  pgm.dropConstraint('inventory_movement_lines', 'chk_movement_lines_canonical_fields', { ifExists: true });
  pgm.dropColumns('inventory_movement_lines', [
    'quantity_delta_entered',
    'uom_entered',
    'quantity_delta_canonical',
    'canonical_uom',
    'uom_dimension'
  ]);

  pgm.dropConstraint('items', 'chk_items_canonical_uom_dimension', { ifExists: true });
  pgm.dropColumns('items', ['uom_dimension', 'canonical_uom', 'stocking_uom']);
}
