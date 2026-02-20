import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('work_order_executions', {
    idempotency_request_hash: { type: 'text' },
    idempotency_request_summary: { type: 'jsonb' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('work_order_executions', ['idempotency_request_summary', 'idempotency_request_hash'], {
    ifExists: true
  });
}
