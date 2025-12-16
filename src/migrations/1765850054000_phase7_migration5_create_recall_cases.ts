import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_cases', {
    id: { type: 'uuid', primaryKey: true },
    recall_number: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true },
    severity: { type: 'text' },
    initiated_at: { type: 'timestamptz' },
    closed_at: { type: 'timestamptz' },
    summary: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('recall_cases', 'chk_recall_cases_status', {
    check: "status IN ('draft','active','closed','canceled')"
  });
  pgm.addConstraint('recall_cases', 'chk_recall_cases_severity', {
    check: "(severity IS NULL) OR severity IN ('low','medium','high','critical')"
  });

  pgm.createIndex('recall_cases', ['status', 'initiated_at'], { name: 'idx_recall_cases_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_cases');
}

