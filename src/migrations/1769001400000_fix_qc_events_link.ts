import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Drop the header-level link
  pgm.dropConstraint('qc_events', 'chk_qc_source_required');
  pgm.dropIndex('qc_events', ['work_order_execution_id', 'occurred_at'], { name: 'idx_qc_events_wo_execution' });
  pgm.dropColumn('qc_events', 'work_order_execution_id');

  // Add the line-level link
  pgm.addColumn('qc_events', {
    work_order_execution_line_id: {
      type: 'uuid',
      references: 'work_order_execution_lines',
      onDelete: 'CASCADE',
      notNull: false
    }
  });

  // Re-add check constraint
  pgm.addConstraint('qc_events', 'chk_qc_source_required', {
    check: `
      (purchase_order_receipt_line_id IS NOT NULL) OR 
      (work_order_id IS NOT NULL) OR 
      (work_order_execution_line_id IS NOT NULL)
    `
  });

  // Add index
  pgm.createIndex('qc_events', ['work_order_execution_line_id', 'occurred_at'], {
    name: 'idx_qc_events_wo_exec_line'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('qc_events', ['work_order_execution_line_id', 'occurred_at'], { name: 'idx_qc_events_wo_exec_line' });
  pgm.dropConstraint('qc_events', 'chk_qc_source_required');
  pgm.dropColumn('qc_events', 'work_order_execution_line_id');

  pgm.addColumn('qc_events', {
    work_order_execution_id: {
      type: 'uuid',
      references: 'work_order_executions',
      onDelete: 'CASCADE',
      notNull: false
    }
  });

  pgm.addConstraint('qc_events', 'chk_qc_source_required', {
    check: `
      (purchase_order_receipt_line_id IS NOT NULL) OR 
      (work_order_id IS NOT NULL) OR 
      (work_order_execution_id IS NOT NULL)
    `
  });
}
