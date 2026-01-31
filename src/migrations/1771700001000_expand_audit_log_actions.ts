import type { MigrationBuilder } from 'node-pg-migrate';

const ACTION_VALUES = "('create','update','delete','post','unpost','import','cancel','negative_override')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('audit_log', 'chk_audit_log_action');
  pgm.addConstraint('audit_log', 'chk_audit_log_action', `CHECK (action IN ${ACTION_VALUES})`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('audit_log', 'chk_audit_log_action');
  pgm.addConstraint(
    'audit_log',
    'chk_audit_log_action',
    "CHECK (action IN ('create','update','delete','post','unpost'))"
  );
}
