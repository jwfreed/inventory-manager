import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('kpi_runs', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    window_start: { type: 'timestamptz' },
    window_end: { type: 'timestamptz' },
    as_of: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('kpi_runs', 'chk_kpi_runs_status', {
    check: "status IN ('draft','computed','published','archived')"
  });

  pgm.createIndex('kpi_runs', ['status', 'created_at'], { name: 'idx_kpi_runs_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('kpi_runs');
}

