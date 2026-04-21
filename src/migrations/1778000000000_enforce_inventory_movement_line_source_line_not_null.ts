import type { MigrationBuilder } from 'node-pg-migrate';

const IDENTITY_INDEX = 'uq_inventory_movement_lines_movement_source_line';
const NON_EMPTY_CHECK = 'chk_inventory_movement_lines_source_line_nonempty';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE inventory_movement_lines
       SET source_line_id = 'syn:' || id::text
     WHERE source_line_id IS NULL
        OR btrim(source_line_id) = '';
  `);

  pgm.alterColumn('inventory_movement_lines', 'source_line_id', {
    notNull: true
  });

  pgm.addConstraint('inventory_movement_lines', NON_EMPTY_CHECK, {
    check: "btrim(source_line_id) <> ''"
  });

  pgm.dropIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    ifExists: true
  });

  pgm.createIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    unique: true
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    ifExists: true
  });

  pgm.createIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    unique: true,
    where: 'source_line_id IS NOT NULL'
  });

  pgm.dropConstraint('inventory_movement_lines', NON_EMPTY_CHECK, { ifExists: true });

  pgm.alterColumn('inventory_movement_lines', 'source_line_id', {
    notNull: false
  });
}
