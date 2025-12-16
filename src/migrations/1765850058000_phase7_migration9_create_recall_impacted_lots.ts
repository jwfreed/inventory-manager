import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_impacted_lots', {
    id: { type: 'uuid', primaryKey: true },
    recall_trace_run_id: {
      type: 'uuid',
      notNull: true,
      references: 'recall_trace_runs',
      onDelete: 'CASCADE'
    },
    lot_id: { type: 'uuid', notNull: true, references: 'lots' },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('recall_impacted_lots', 'chk_recall_impacted_lot_role', {
    check: "role IN ('target','upstream_component','downstream_finished')"
  });

  pgm.addConstraint('recall_impacted_lots', 'unique_recall_lot_role', {
    unique: ['recall_trace_run_id', 'lot_id', 'role']
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_impacted_lots');
}

