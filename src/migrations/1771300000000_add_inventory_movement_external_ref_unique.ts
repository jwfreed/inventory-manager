import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createIndex('inventory_movements', ['tenant_id', 'external_ref'], {
    name: 'uq_inventory_movements_tenant_external_ref',
    unique: true,
    where: 'external_ref IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movements', ['tenant_id', 'external_ref'], {
    name: 'uq_inventory_movements_tenant_external_ref',
    ifExists: true
  });
}
