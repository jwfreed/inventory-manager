import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('kpi_rollup_inputs', {
    id: { type: 'uuid', primaryKey: true },
    kpi_run_id: { type: 'uuid', notNull: true, references: 'kpi_runs', onDelete: 'CASCADE' },
    metric_name: { type: 'text', notNull: true },
    dimensions: { type: 'jsonb', notNull: true },
    numerator_qty: { type: 'numeric(18,6)' },
    denominator_qty: { type: 'numeric(18,6)' },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('kpi_rollup_inputs', ['kpi_run_id', 'metric_name'], { name: 'idx_kpi_rollup_inputs_run' });
  pgm.createIndex('kpi_rollup_inputs', 'dimensions', {
    name: 'idx_kpi_rollup_inputs_dimensions_gin',
    method: 'gin'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('kpi_rollup_inputs');
}

