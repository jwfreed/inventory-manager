import type { MigrationBuilder } from 'node-pg-migrate';

const TRANSFER_EXEC_STATUS = "('IN_PROGRESS','SUCCEEDED','FAILED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('transfer_post_executions', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    idempotency_key: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    request_summary: { type: 'jsonb' },
    status: { type: 'text', notNull: true, default: 'IN_PROGRESS' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('transfer_post_executions', 'chk_transfer_post_exec_status', {
    check: `status IN ${TRANSFER_EXEC_STATUS}`
  });

  pgm.addConstraint('transfer_post_executions', 'uq_transfer_post_exec_idempotency', {
    unique: ['tenant_id', 'idempotency_key']
  });

  pgm.createIndex('transfer_post_executions', ['tenant_id', 'inventory_movement_id'], {
    name: 'idx_transfer_post_exec_tenant_movement'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('transfer_post_executions', ['tenant_id', 'inventory_movement_id'], {
    name: 'idx_transfer_post_exec_tenant_movement',
    ifExists: true
  });
  pgm.dropConstraint('transfer_post_executions', 'uq_transfer_post_exec_idempotency', { ifExists: true });
  pgm.dropConstraint('transfer_post_executions', 'chk_transfer_post_exec_status', { ifExists: true });
  pgm.dropTable('transfer_post_executions', { ifExists: true });
}
