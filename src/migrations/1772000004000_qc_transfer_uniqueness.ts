import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Ensure QC transfers are idempotent: one transfer per qc_event
  // QC disposition transfers existing inventory; cost layers are receipt-authored only. Transfers never create/modify cost layers.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_qc_event_transfer
    ON qc_inventory_links (tenant_id, qc_event_id)
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('qc_inventory_links', 'uq_qc_event_transfer', { ifExists: true });
}
