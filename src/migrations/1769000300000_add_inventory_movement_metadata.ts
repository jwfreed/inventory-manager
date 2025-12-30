import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('inventory_movements', {
    metadata: { type: 'jsonb' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('inventory_movements', 'metadata');
}
