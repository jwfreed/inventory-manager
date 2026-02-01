import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE inventory_movements
       SET source_type = 'po_receipt',
           source_id = split_part(external_ref, ':', 2)
     WHERE source_type IS NULL
       AND external_ref LIKE 'po_receipt:%'
  `);

  pgm.sql(`
    UPDATE inventory_movements
       SET source_type = 'qc_event',
           source_id = split_part(external_ref, ':', 2)
     WHERE source_type IS NULL
       AND external_ref LIKE 'qc_%:%'
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE inventory_movements
       SET source_type = NULL,
           source_id = NULL
     WHERE source_type IN ('po_receipt','qc_event')
       AND external_ref LIKE 'po_receipt:%'
  `);
  pgm.sql(`
    UPDATE inventory_movements
       SET source_type = NULL,
           source_id = NULL
     WHERE source_type = 'qc_event'
       AND external_ref LIKE 'qc_%:%'
  `);
}
