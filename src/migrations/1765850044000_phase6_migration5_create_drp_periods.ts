import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_periods', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    period_start: { type: 'date', notNull: true },
    period_end: { type: 'date', notNull: true },
    sequence: { type: 'integer', notNull: true }
  });

  pgm.addConstraint('drp_periods', 'unique_drp_period_sequence', {
    unique: ['drp_run_id', 'sequence']
  });
  pgm.addConstraint('drp_periods', 'unique_drp_period_range', {
    unique: ['drp_run_id', 'period_start', 'period_end']
  });
  pgm.addConstraint('drp_periods', 'chk_drp_period_dates', { check: 'period_start <= period_end' });

  pgm.createIndex('drp_periods', ['drp_run_id', 'period_start'], { name: 'idx_drp_periods_run' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_periods');
}

