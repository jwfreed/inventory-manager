import type { MigrationBuilder } from 'node-pg-migrate';

const SEQUENCE_NAME = 'outbox_events_event_seq_seq';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('outbox_events', {
    event_seq: { type: 'bigint' }
  });

  pgm.createSequence(SEQUENCE_NAME);

  pgm.alterColumn('outbox_events', 'event_seq', {
    default: pgm.func(`nextval('${SEQUENCE_NAME}')`)
  });

  pgm.sql(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS seq
      FROM outbox_events
    )
    UPDATE outbox_events o
       SET event_seq = ordered.seq
      FROM ordered
     WHERE o.id = ordered.id;
  `);

  pgm.sql(`
    SELECT setval(
      '${SEQUENCE_NAME}',
      COALESCE((SELECT MAX(event_seq) FROM outbox_events), 1),
      (SELECT COUNT(*) > 0 FROM outbox_events)
    );
  `);

  pgm.alterColumn('outbox_events', 'event_seq', { notNull: true });
  pgm.createIndex('outbox_events', ['tenant_id', 'event_seq'], { name: 'idx_outbox_tenant_seq' });
  pgm.createIndex('outbox_events', ['event_seq'], { name: 'idx_outbox_event_seq' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('outbox_events', 'idx_outbox_tenant_seq');
  pgm.dropIndex('outbox_events', 'idx_outbox_event_seq');
  pgm.dropColumn('outbox_events', 'event_seq');
  pgm.dropSequence(SEQUENCE_NAME);
}
