import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('cycle_counts', {
    counter_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    approved_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    approved_at: { type: 'timestamptz' },
    posted_at: { type: 'timestamptz' }
  });

  pgm.addColumn('cycle_count_lines', {
    reason_code: { type: 'text' }
  });

  pgm.addConstraint(
    'cycle_count_lines',
    'chk_cycle_count_lines_reason_required',
    'CHECK (variance_quantity IS NULL OR variance_quantity = 0 OR reason_code IS NOT NULL)'
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('cycle_count_lines', 'chk_cycle_count_lines_reason_required');
  pgm.dropColumn('cycle_count_lines', 'reason_code');
  pgm.dropColumn('cycle_counts', 'posted_at');
  pgm.dropColumn('cycle_counts', 'approved_at');
  pgm.dropColumn('cycle_counts', 'approved_by');
  pgm.dropColumn('cycle_counts', 'counter_id');
}
