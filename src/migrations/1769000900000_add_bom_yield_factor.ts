import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('bom_versions', {
    yield_factor: { type: 'numeric(5,4)', notNull: true, default: 1.0 }
  });

  pgm.addConstraint('bom_versions', 'chk_bom_versions_yield_factor_positive', {
    check: 'yield_factor > 0 AND yield_factor <= 1.0'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('bom_versions', 'yield_factor');
}
