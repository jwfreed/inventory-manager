import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('kpi_snapshots', {
    id: { type: 'uuid', primaryKey: true },
    kpi_run_id: { type: 'uuid', notNull: true, references: 'kpi_runs', onDelete: 'CASCADE' },
    kpi_name: { type: 'text', notNull: true },
    dimensions: { type: 'jsonb', notNull: true },
    value: { type: 'numeric(18,6)' },
    units: { type: 'text' },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('kpi_snapshots', ['kpi_run_id', 'kpi_name'], { name: 'idx_kpi_snapshots_run' });
  pgm.createIndex('kpi_snapshots', 'dimensions', {
    name: 'idx_kpi_snapshots_dimensions_gin',
    method: 'gin'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('kpi_snapshots');
}

