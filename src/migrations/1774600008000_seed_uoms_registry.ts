import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO uoms (code, name, dimension, base_code, to_base_factor, precision, active, created_at, updated_at)
    VALUES
      ('ea', 'Each', 'count', 'ea', 1, 6, true, now(), now()),
      ('dozen', 'Dozen', 'count', 'ea', 12, 6, true, now(), now()),
      ('g', 'Gram', 'mass', 'g', 1, 6, true, now(), now()),
      ('kg', 'Kilogram', 'mass', 'g', 1000, 6, true, now(), now()),
      ('lb', 'Pound', 'mass', 'g', 453.59237, 6, true, now(), now()),
      ('mm', 'Millimeter', 'length', 'mm', 1, 6, true, now(), now()),
      ('cm', 'Centimeter', 'length', 'mm', 10, 6, true, now(), now()),
      ('m', 'Meter', 'length', 'mm', 1000, 6, true, now(), now()),
      ('in', 'Inch', 'length', 'mm', 25.4, 6, true, now(), now()),
      ('ml', 'Milliliter', 'volume', 'ml', 1, 6, true, now(), now()),
      ('l', 'Liter', 'volume', 'ml', 1000, 6, true, now(), now()),
      ('gal_us', 'US Gallon', 'volume', 'ml', 3785.411784, 6, true, now(), now())
    ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          dimension = EXCLUDED.dimension,
          base_code = EXCLUDED.base_code,
          to_base_factor = EXCLUDED.to_base_factor,
          precision = EXCLUDED.precision,
          active = EXCLUDED.active,
          updated_at = now();
  `);

  pgm.sql(`
    INSERT INTO uom_aliases (alias_code, canonical_code, created_at, updated_at)
    VALUES
      ('each', 'ea', now(), now()),
      ('L', 'l', now(), now()),
      ('pcs', 'ea', now(), now()),
      ('pc', 'ea', now(), now())
    ON CONFLICT (alias_code) DO UPDATE
      SET canonical_code = EXCLUDED.canonical_code,
          updated_at = now();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM uom_aliases WHERE alias_code IN ('each', 'L', 'pcs', 'pc');`);
  pgm.sql(`
    DELETE FROM uoms
     WHERE code IN ('ea', 'dozen', 'g', 'kg', 'lb', 'mm', 'cm', 'm', 'in', 'ml', 'l', 'gal_us');
  `);
}
