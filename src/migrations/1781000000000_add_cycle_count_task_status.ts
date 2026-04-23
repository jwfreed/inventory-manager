import type { MigrationBuilder } from 'node-pg-migrate';

const TASK_STATUS = "('pending', 'counted', 'reconciled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Per-task status for the individual reconciliation workflow (WP7).
  // task_status tracks: pending → counted → reconciled
  pgm.addColumns('cycle_count_lines', {
    task_status: { type: 'text', notNull: true, default: 'pending' },
    // system_qty_snapshot: immutable snapshot taken at task-creation time.
    // Distinct from system_quantity (which postInventoryCount writes at posting time).
    system_qty_snapshot: { type: 'numeric(18,6)' },
    reconciled_movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'SET NULL'
    },
    reconciled_at: { type: 'timestamptz' }
  });

  pgm.addConstraint(
    'cycle_count_lines',
    'chk_cycle_count_lines_task_status',
    `CHECK (task_status IN ${TASK_STATUS})`
  );

  // Guard: reconciled_movement_id requires reconciled_at and vice versa
  pgm.sql(`
    ALTER TABLE cycle_count_lines
      ADD CONSTRAINT chk_cycle_count_lines_reconcile_pair
      CHECK (
        (reconciled_movement_id IS NULL) = (reconciled_at IS NULL)
      )
      NOT VALID;
  `);

  pgm.createIndex('cycle_count_lines', ['cycle_count_id', 'task_status'], {
    name: 'idx_cycle_count_lines_count_task_status'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('cycle_count_lines', ['cycle_count_id', 'task_status'], {
    name: 'idx_cycle_count_lines_count_task_status'
  });
  pgm.dropConstraint('cycle_count_lines', 'chk_cycle_count_lines_reconcile_pair', {
    ifExists: true
  });
  pgm.dropConstraint('cycle_count_lines', 'chk_cycle_count_lines_task_status');
  pgm.dropColumn('cycle_count_lines', 'reconciled_at');
  pgm.dropColumn('cycle_count_lines', 'reconciled_movement_id');
  pgm.dropColumn('cycle_count_lines', 'system_qty_snapshot');
  pgm.dropColumn('cycle_count_lines', 'task_status');
}
