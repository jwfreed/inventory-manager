import type { MigrationBuilder } from 'node-pg-migrate';

// Phase 5 created kpi_runs; this migration is idempotent to keep Phase 7 ordering consistent.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    'kpi_runs',
    {
      id: { type: 'uuid', primaryKey: true },
      status: { type: 'text', notNull: true },
      window_start: { type: 'timestamptz' },
      window_end: { type: 'timestamptz' },
      as_of: { type: 'timestamptz' },
      notes: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
    },
    { ifNotExists: true }
  );

  pgm.createIndex('kpi_runs', ['status', 'created_at'], {
    name: 'idx_kpi_runs_status',
    ifNotExists: true
  });
}

export async function down(): Promise<void> {
  // Existing Phase 5 tables satisfy this migration; no-op on down.
}
