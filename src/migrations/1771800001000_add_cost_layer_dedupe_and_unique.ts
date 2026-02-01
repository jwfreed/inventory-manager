import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('inventory_cost_layers', {
    voided_at: { type: 'timestamptz' },
    void_reason: { type: 'text' },
    superseded_by_id: { type: 'uuid', references: 'inventory_cost_layers', onDelete: 'SET NULL' }
  });

  // Dedupe active receipt layers by source_document_id.
  pgm.sql(`
    WITH ranked AS (
      SELECT id,
             tenant_id,
             source_document_id,
             created_at,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, source_document_id
               ORDER BY created_at ASC, id ASC
             ) AS rn,
             FIRST_VALUE(id) OVER (
               PARTITION BY tenant_id, source_document_id
               ORDER BY created_at ASC, id ASC
             ) AS keep_id
        FROM inventory_cost_layers
       WHERE source_type = 'receipt'
         AND source_document_id IS NOT NULL
         AND voided_at IS NULL
    )
    UPDATE inventory_cost_layers c
       SET voided_at = now(),
           void_reason = 'superseded duplicate',
           superseded_by_id = r.keep_id
      FROM ranked r
     WHERE c.id = r.id
       AND r.rn > 1
  `);

  pgm.dropIndex('inventory_cost_layers', 'uq_cost_layers_receipt_source', { ifExists: true });

  pgm.createIndex('inventory_cost_layers', ['tenant_id', 'source_document_id'], {
    name: 'uq_cost_layers_receipt_source_active',
    unique: true,
    where: "source_type = 'receipt' AND source_document_id IS NOT NULL AND voided_at IS NULL"
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_cost_layers', 'uq_cost_layers_receipt_source_active', { ifExists: true });
  pgm.createIndex('inventory_cost_layers', ['tenant_id', 'source_type', 'source_document_id'], {
    name: 'uq_cost_layers_receipt_source',
    unique: true,
    where: "source_type = 'receipt' AND source_document_id IS NOT NULL"
  });
  pgm.dropColumns('inventory_cost_layers', ['voided_at', 'void_reason', 'superseded_by_id']);
}
