import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_runs', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    bucket_type: { type: 'text', notNull: true },
    starts_on: { type: 'date', notNull: true },
    ends_on: { type: 'date', notNull: true },
    as_of: { type: 'timestamptz', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('drp_runs', 'chk_drp_runs_status', {
    check: "status IN ('draft','computed','published','archived')"
  });
  pgm.addConstraint('drp_runs', 'chk_drp_runs_bucket_type', {
    check: "bucket_type IN ('day','week','month')"
  });
  pgm.addConstraint('drp_runs', 'chk_drp_runs_date_range', { check: 'starts_on <= ends_on' });

  pgm.createIndex('drp_runs', 'status', { name: 'idx_drp_runs_status' });
  pgm.createIndex('drp_runs', ['starts_on', 'ends_on'], { name: 'idx_drp_runs_window' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_runs');
}

