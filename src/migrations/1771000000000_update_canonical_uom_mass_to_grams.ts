import type { MigrationBuilder } from 'node-pg-migrate';

const ITEMS_CHECK = `CHECK (
  (uom_dimension IS NULL AND canonical_uom IS NULL AND stocking_uom IS NULL)
  OR (
    uom_dimension IS NOT NULL
    AND canonical_uom IS NOT NULL
    AND stocking_uom IS NOT NULL
    AND (
      (uom_dimension = 'mass' AND canonical_uom = 'g')
      OR (uom_dimension = 'volume' AND canonical_uom = 'L')
      OR (uom_dimension = 'count' AND canonical_uom = 'each')
      OR (uom_dimension = 'length' AND canonical_uom = 'm')
      OR (uom_dimension = 'area' AND canonical_uom = 'm2')
      OR (uom_dimension = 'time' AND canonical_uom = 'seconds')
    )
  )
)`;

const MOVEMENT_CHECK = `CHECK (
  (quantity_delta_canonical IS NULL AND canonical_uom IS NULL AND uom_dimension IS NULL
   AND quantity_delta_entered IS NULL AND uom_entered IS NULL)
  OR (
    quantity_delta_canonical IS NOT NULL AND canonical_uom IS NOT NULL AND uom_dimension IS NOT NULL
    AND quantity_delta_entered IS NOT NULL AND uom_entered IS NOT NULL
    AND (
      (uom_dimension = 'mass' AND canonical_uom = 'g')
      OR (uom_dimension = 'volume' AND canonical_uom = 'L')
      OR (uom_dimension = 'count' AND canonical_uom = 'each')
      OR (uom_dimension = 'length' AND canonical_uom = 'm')
      OR (uom_dimension = 'area' AND canonical_uom = 'm2')
      OR (uom_dimension = 'time' AND canonical_uom = 'seconds')
    )
  )
)`;

const BOM_CHECK = `CHECK (
  (component_quantity_canonical IS NULL AND component_uom_canonical IS NULL AND component_uom_dimension IS NULL
   AND component_quantity_entered IS NULL AND component_uom_entered IS NULL)
  OR (
    component_quantity_canonical IS NOT NULL AND component_uom_canonical IS NOT NULL AND component_uom_dimension IS NOT NULL
    AND component_quantity_entered IS NOT NULL AND component_uom_entered IS NOT NULL
    AND (
      (component_uom_dimension = 'mass' AND component_uom_canonical = 'g')
      OR (component_uom_dimension = 'volume' AND component_uom_canonical = 'L')
      OR (component_uom_dimension = 'count' AND component_uom_canonical = 'each')
      OR (component_uom_dimension = 'length' AND component_uom_canonical = 'm')
      OR (component_uom_dimension = 'area' AND component_uom_canonical = 'm2')
      OR (component_uom_dimension = 'time' AND component_uom_canonical = 'seconds')
    )
  )
)`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('items', 'chk_items_canonical_uom_dimension', { ifExists: true });
  pgm.dropConstraint('inventory_movement_lines', 'chk_movement_lines_canonical_fields', { ifExists: true });
  pgm.dropConstraint('bom_version_lines', 'chk_bom_lines_canonical_fields', { ifExists: true });

  pgm.sql(`
    UPDATE items
      SET uom_dimension = CASE
        WHEN canonical_uom = 'g' OR canonical_uom = 'kg' OR stocking_uom = 'g' OR stocking_uom = 'kg' THEN 'mass'
        WHEN canonical_uom = 'L' OR stocking_uom = 'L' THEN 'volume'
        WHEN canonical_uom = 'each' OR stocking_uom = 'each' THEN 'count'
        WHEN canonical_uom = 'm' OR stocking_uom = 'm' THEN 'length'
        WHEN canonical_uom = 'm2' OR stocking_uom = 'm2' THEN 'area'
        WHEN canonical_uom = 'seconds' OR stocking_uom = 'seconds' THEN 'time'
        ELSE uom_dimension
      END
      WHERE uom_dimension IS NULL AND (canonical_uom IS NOT NULL OR stocking_uom IS NOT NULL);
  `);

  pgm.sql(`
    UPDATE items
      SET canonical_uom = CASE uom_dimension
        WHEN 'mass' THEN 'g'
        WHEN 'volume' THEN 'L'
        WHEN 'count' THEN 'each'
        WHEN 'length' THEN 'm'
        WHEN 'area' THEN 'm2'
        WHEN 'time' THEN 'seconds'
        ELSE canonical_uom
      END
      WHERE uom_dimension IS NOT NULL AND (canonical_uom IS NULL OR canonical_uom NOT IN ('g','L','each','m','m2','seconds'));
  `);

  pgm.sql(`
    UPDATE inventory_movement_lines
      SET uom_dimension = CASE
        WHEN canonical_uom = 'g' OR canonical_uom = 'kg' OR uom_entered = 'g' OR uom_entered = 'kg' THEN 'mass'
        WHEN canonical_uom = 'L' OR uom_entered = 'L' THEN 'volume'
        WHEN canonical_uom = 'each' OR uom_entered = 'each' THEN 'count'
        WHEN canonical_uom = 'm' OR uom_entered = 'm' THEN 'length'
        WHEN canonical_uom = 'm2' OR uom_entered = 'm2' THEN 'area'
        WHEN canonical_uom = 'seconds' OR uom_entered = 'seconds' THEN 'time'
        ELSE uom_dimension
      END
      WHERE uom_dimension IS NULL AND (canonical_uom IS NOT NULL OR uom_entered IS NOT NULL);
  `);

  pgm.sql(`
    UPDATE inventory_movement_lines
      SET canonical_uom = CASE uom_dimension
        WHEN 'mass' THEN 'g'
        WHEN 'volume' THEN 'L'
        WHEN 'count' THEN 'each'
        WHEN 'length' THEN 'm'
        WHEN 'area' THEN 'm2'
        WHEN 'time' THEN 'seconds'
        ELSE canonical_uom
      END
      WHERE uom_dimension IS NOT NULL AND (canonical_uom IS NULL OR canonical_uom NOT IN ('g','L','each','m','m2','seconds'));
  `);

  pgm.sql(`
    UPDATE bom_version_lines
      SET component_uom_dimension = CASE
        WHEN component_uom_canonical = 'g' OR component_uom_canonical = 'kg'
          OR component_uom_entered = 'g' OR component_uom_entered = 'kg' THEN 'mass'
        WHEN component_uom_canonical = 'L' OR component_uom_entered = 'L' THEN 'volume'
        WHEN component_uom_canonical = 'each' OR component_uom_entered = 'each' THEN 'count'
        WHEN component_uom_canonical = 'm' OR component_uom_entered = 'm' THEN 'length'
        WHEN component_uom_canonical = 'm2' OR component_uom_entered = 'm2' THEN 'area'
        WHEN component_uom_canonical = 'seconds' OR component_uom_entered = 'seconds' THEN 'time'
        ELSE component_uom_dimension
      END
      WHERE component_uom_dimension IS NULL
        AND (component_uom_canonical IS NOT NULL OR component_uom_entered IS NOT NULL);
  `);

  pgm.sql(`
    UPDATE bom_version_lines
      SET component_uom_canonical = CASE component_uom_dimension
        WHEN 'mass' THEN 'g'
        WHEN 'volume' THEN 'L'
        WHEN 'count' THEN 'each'
        WHEN 'length' THEN 'm'
        WHEN 'area' THEN 'm2'
        WHEN 'time' THEN 'seconds'
        ELSE component_uom_canonical
      END
      WHERE component_uom_dimension IS NOT NULL
        AND (component_uom_canonical IS NULL OR component_uom_canonical NOT IN ('g','L','each','m','m2','seconds'));
  `);

  pgm.addConstraint('items', 'chk_items_canonical_uom_dimension', ITEMS_CHECK);

  pgm.addConstraint('inventory_movement_lines', 'chk_movement_lines_canonical_fields', MOVEMENT_CHECK);

  pgm.addConstraint('bom_version_lines', 'chk_bom_lines_canonical_fields', BOM_CHECK);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('items', 'chk_items_canonical_uom_dimension', { ifExists: true });
  pgm.addConstraint(
    'items',
    'chk_items_canonical_uom_dimension',
    ITEMS_CHECK.replace(/canonical_uom = 'g'/g, "canonical_uom = 'kg'")
  );

  pgm.dropConstraint('inventory_movement_lines', 'chk_movement_lines_canonical_fields', { ifExists: true });
  pgm.addConstraint(
    'inventory_movement_lines',
    'chk_movement_lines_canonical_fields',
    MOVEMENT_CHECK.replace(/canonical_uom = 'g'/g, "canonical_uom = 'kg'")
  );

  pgm.dropConstraint('bom_version_lines', 'chk_bom_lines_canonical_fields', { ifExists: true });
  pgm.addConstraint(
    'bom_version_lines',
    'chk_bom_lines_canonical_fields',
    BOM_CHECK.replace(/component_uom_canonical = 'g'/g, "component_uom_canonical = 'kg'")
  );
}
