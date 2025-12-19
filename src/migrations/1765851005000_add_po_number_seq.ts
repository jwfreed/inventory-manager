import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createSequence('po_number_seq', {
    minvalue: 1,
    start: 1,
    increment: 1,
    ifNotExists: true
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropSequence('po_number_seq', { ifExists: true });
}
