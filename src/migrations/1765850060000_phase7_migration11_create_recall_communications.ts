import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('recall_communications', {
    id: { type: 'uuid', primaryKey: true },
    recall_case_id: { type: 'uuid', notNull: true, references: 'recall_cases', onDelete: 'CASCADE' },
    customer_id: { type: 'uuid', references: 'customers' },
    channel: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    sent_at: { type: 'timestamptz' },
    subject: { type: 'text' },
    body: { type: 'text' },
    external_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('recall_communications', 'chk_recall_communications_channel', {
    check: "channel IN ('email','phone','letter','portal')"
  });
  pgm.addConstraint('recall_communications', 'chk_recall_communications_status', {
    check: "status IN ('draft','sent','failed')"
  });

  pgm.createIndex('recall_communications', ['recall_case_id', 'created_at'], {
    name: 'idx_recall_communications_case'
  });
  pgm.createIndex('recall_communications', 'customer_id', {
    name: 'idx_recall_communications_customer'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recall_communications');
}

