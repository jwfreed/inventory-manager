import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('inventory_balance', {
    allocated: { type: 'numeric(18,6)', notNull: true, default: 0 },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('inventory_balance', 'allocated', { ifExists: true });
}
