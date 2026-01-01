import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Make purchase_order_receipt_line_id nullable
  pgm.alterColumn('qc_events', 'purchase_order_receipt_line_id', {
    notNull: false
  });

  // Add work_order_id for Finished Goods QC
  pgm.addColumn('qc_events', {
    work_order_id: {
      type: 'uuid',
      references: 'work_orders',
      onDelete: 'CASCADE',
      notNull: false
    }
  });

  // Add work_order_execution_id for In-Process QC
  pgm.addColumn('qc_events', {
    work_order_execution_id: {
      type: 'uuid',
      references: 'work_order_executions',
      onDelete: 'CASCADE',
      notNull: false
    }
  });

  // Add check constraint to ensure at least one source is present
  pgm.addConstraint('qc_events', 'chk_qc_source_required', {
    check: `
      (purchase_order_receipt_line_id IS NOT NULL) OR 
      (work_order_id IS NOT NULL) OR 
      (work_order_execution_id IS NOT NULL)
    `
  });

  // Add indexes for new columns
  pgm.createIndex('qc_events', ['work_order_id', 'occurred_at'], {
    name: 'idx_qc_events_work_order'
  });
  pgm.createIndex('qc_events', ['work_order_execution_id', 'occurred_at'], {
    name: 'idx_qc_events_wo_execution'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('qc_events', ['work_order_execution_id', 'occurred_at'], { name: 'idx_qc_events_wo_execution' });
  pgm.dropIndex('qc_events', ['work_order_id', 'occurred_at'], { name: 'idx_qc_events_work_order' });
  
  pgm.dropConstraint('qc_events', 'chk_qc_source_required');
  
  pgm.dropColumn('qc_events', 'work_order_execution_id');
  pgm.dropColumn('qc_events', 'work_order_id');
  
  // Note: We can't easily make purchase_order_receipt_line_id NOT NULL again 
  // without ensuring no rows violate it, but for 'down' migration we assume 
  // we are reverting to previous state where only PO receipts existed.
  // However, if we added WO QC events, this would fail. 
  // For safety in dev, we'll just try to set it back.
  pgm.alterColumn('qc_events', 'purchase_order_receipt_line_id', {
    notNull: true
  });
}
