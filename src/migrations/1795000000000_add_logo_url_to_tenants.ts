import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('tenants', {
    logo_url: { type: 'text', notNull: false }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('tenants', 'logo_url');
}
