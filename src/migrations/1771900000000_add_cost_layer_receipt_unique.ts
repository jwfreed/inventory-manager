import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createIndex('inventory_cost_layers', ['tenant_id', 'source_type', 'source_document_id'], {
    name: 'uq_cost_layers_receipt_source',
    unique: false,
    where: "source_type = 'receipt' AND source_document_id IS NOT NULL"
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_cost_layers', 'uq_cost_layers_receipt_source', { ifExists: true });
}
