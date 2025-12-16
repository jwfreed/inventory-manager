import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_periods', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_id: { type: 'uuid', notNull: true, references: 'mps_plans', onDelete: 'CASCADE' },
    period_start: { type: 'date', notNull: true },
    period_end: { type: 'date', notNull: true },
    sequence: { type: 'integer', notNull: true }
  });

  pgm.addConstraint('mps_periods', 'unique_mps_period_sequence', {
    unique: ['mps_plan_id', 'sequence']
  });
  pgm.addConstraint('mps_periods', 'unique_mps_period_range', {
    unique: ['mps_plan_id', 'period_start', 'period_end']
  });
  pgm.addConstraint('mps_periods', 'chk_mps_period_dates', {
    check: 'period_start <= period_end'
  });

  pgm.createIndex('mps_periods', ['mps_plan_id', 'period_start'], { name: 'idx_mps_periods_plan' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_periods');
}

