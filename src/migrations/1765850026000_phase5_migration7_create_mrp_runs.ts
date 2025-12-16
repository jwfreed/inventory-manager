import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mrp_runs', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_id: { type: 'uuid', notNull: true, references: 'mps_plans' },
    status: { type: 'text', notNull: true },
    as_of: { type: 'timestamptz', notNull: true },
    bucket_type: { type: 'text', notNull: true },
    starts_on: { type: 'date', notNull: true },
    ends_on: { type: 'date', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mrp_runs', 'chk_mrp_runs_status', {
    check: "status IN ('draft','computed','published','archived')"
  });
  pgm.addConstraint('mrp_runs', 'chk_mrp_runs_bucket_type', {
    check: "bucket_type IN ('day','week','month')"
  });

  pgm.createIndex('mrp_runs', 'mps_plan_id', { name: 'idx_mrp_runs_mps' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mrp_runs');
}

