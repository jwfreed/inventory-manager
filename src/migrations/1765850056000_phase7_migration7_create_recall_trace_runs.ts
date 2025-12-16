import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_trace_runs', {
    id: { type: 'uuid', primaryKey: true },
    recall_case_id: { type: 'uuid', notNull: true, references: 'recall_cases', onDelete: 'CASCADE' },
    as_of: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true },
    notes: { type: 'text' },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('recall_trace_runs', 'chk_recall_trace_status', {
    check: "status IN ('computed','superseded')"
  });

  pgm.createIndex('recall_trace_runs', ['recall_case_id', 'computed_at'], {
    name: 'idx_recall_trace_runs_case'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_trace_runs');
}

