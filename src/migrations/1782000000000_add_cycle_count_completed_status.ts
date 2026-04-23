import type { MigrationBuilder } from 'node-pg-migrate';

// WP7b: adds 'completed' to the cycle_counts status CHECK constraint.
// Completed sessions have all tasks reconciled and are immutable.
// Note: PostgreSQL does not support ALTER CONSTRAINT, so the old constraint
// must be dropped and a new one created.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('cycle_counts', 'chk_cycle_counts_status');
  pgm.addConstraint(
    'cycle_counts',
    'chk_cycle_counts_status',
    `CHECK (status IN ('draft','in_progress','completed','posted','canceled'))`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('cycle_counts', 'chk_cycle_counts_status');
  pgm.addConstraint(
    'cycle_counts',
    'chk_cycle_counts_status',
    `CHECK (status IN ('draft','in_progress','posted','canceled'))`
  );
}
