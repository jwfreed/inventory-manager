import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_case_targets', {
    id: { type: 'uuid', primaryKey: true },
    recall_case_id: { type: 'uuid', notNull: true, references: 'recall_cases', onDelete: 'CASCADE' },
    target_type: { type: 'text', notNull: true },
    lot_id: { type: 'uuid', references: 'lots' },
    item_id: { type: 'uuid', references: 'items' },
    uom: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('recall_case_targets', 'chk_recall_targets_type', {
    check: "target_type IN ('lot','item')"
  });

  pgm.createIndex(
    'recall_case_targets',
    ['recall_case_id', 'target_type', 'lot_id', 'item_id', 'uom'],
    { name: 'idx_recall_targets_unique', unique: true }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_case_targets');
}

