import type { MigrationBuilder } from 'node-pg-migrate';

const ACTOR_TYPE_VALUES = "('user','system')";
const ACTION_VALUES = "('create','update','delete','post','unpost')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('audit_log', {
    id: { type: 'uuid', primaryKey: true },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    actor_type: { type: 'text', notNull: true },
    actor_id: { type: 'text' },
    action: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'uuid', notNull: true },
    request_id: { type: 'text' },
    metadata: { type: 'jsonb' },
    before: { type: 'jsonb' },
    after: { type: 'jsonb' }
  });

  pgm.createIndex('audit_log', 'occurred_at', { name: 'idx_audit_log_occurred' });
  pgm.createIndex('audit_log', ['entity_type', 'entity_id', 'occurred_at'], {
    name: 'idx_audit_log_entity'
  });
  pgm.createIndex('audit_log', ['actor_type', 'actor_id', 'occurred_at'], {
    name: 'idx_audit_log_actor'
  });
  pgm.createIndex('audit_log', 'request_id', { name: 'idx_audit_log_request_id' });
  pgm.addConstraint('audit_log', 'chk_audit_log_actor_type', `CHECK (actor_type IN ${ACTOR_TYPE_VALUES})`);
  pgm.addConstraint('audit_log', 'chk_audit_log_action', `CHECK (action IN ${ACTION_VALUES})`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('audit_log');
}
