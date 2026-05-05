import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('import_job_rows', {
    lot_number: { type: 'text' },
    serial_number: { type: 'text' }
  });

  // Backfill from normalized JSONB for existing on-hand import rows
  pgm.sql(`
    UPDATE import_job_rows
       SET lot_number    = NULLIF(TRIM(normalized->>'lotNumber'), ''),
           serial_number = NULLIF(TRIM(normalized->>'serialNumber'), '')
     WHERE normalized IS NOT NULL
  `);

  // Partial indexes for queryability by downstream systems (traceability, recall, FEFO)
  pgm.createIndex('import_job_rows', ['job_id', 'lot_number'], {
    name: 'idx_import_job_rows_job_lot',
    where: 'lot_number IS NOT NULL'
  });

  pgm.createIndex('import_job_rows', ['job_id', 'serial_number'], {
    name: 'idx_import_job_rows_job_serial',
    where: 'serial_number IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('import_job_rows', ['job_id', 'serial_number'], {
    name: 'idx_import_job_rows_job_serial',
    ifExists: true
  });
  pgm.dropIndex('import_job_rows', ['job_id', 'lot_number'], {
    name: 'idx_import_job_rows_job_lot',
    ifExists: true
  });
  pgm.dropColumns('import_job_rows', ['lot_number', 'serial_number']);
}
