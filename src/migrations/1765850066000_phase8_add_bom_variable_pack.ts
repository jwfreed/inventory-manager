import { type MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('bom_version_lines', {
    uses_pack_size: { type: 'boolean', notNull: true, default: false },
    variable_uom: { type: 'text' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('bom_version_lines', ['uses_pack_size', 'variable_uom']);
}
