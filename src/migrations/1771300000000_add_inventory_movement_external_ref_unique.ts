import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint('inventory_movements', 'uq_inventory_movements_tenant_external_ref', {
    unique: ['tenant_id', 'external_ref'],
    where: 'external_ref IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_movements', 'uq_inventory_movements_tenant_external_ref', { ifExists: true });
}
