import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_plans', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true },
    bucket_type: { type: 'text', notNull: true },
    starts_on: { type: 'date', notNull: true },
    ends_on: { type: 'date', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('mps_plans', 'chk_mps_plans_status', {
    check: "status IN ('draft','published','archived')"
  });
  pgm.addConstraint('mps_plans', 'chk_mps_bucket_type', {
    check: "bucket_type IN ('day','week','month')"
  });
  pgm.addConstraint('mps_plans', 'chk_mps_date_range', {
    check: 'starts_on <= ends_on'
  });

  pgm.createIndex('mps_plans', 'status', { name: 'idx_mps_plans_status' });
  pgm.createIndex('mps_plans', ['starts_on', 'ends_on'], { name: 'idx_mps_plans_window' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_plans');
}

