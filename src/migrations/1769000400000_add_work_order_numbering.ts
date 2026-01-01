import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

  pgm.addColumn('work_orders', {
    number: { type: 'text' },
    description: { type: 'text' }
  });

  pgm.sql(`
    WITH ordered AS (
      SELECT id,
             tenant_id,
             ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at ASC, id ASC) AS rn
        FROM work_orders
    )
    UPDATE work_orders w
       SET number = 'WO-' || LPAD(ordered.rn::text, 6, '0'),
           work_order_number = 'WO-' || LPAD(ordered.rn::text, 6, '0')
      FROM ordered
     WHERE w.id = ordered.id
       AND (w.number IS NULL OR w.number = '');
  `);

  pgm.sql(`
    UPDATE work_orders
       SET description = notes
     WHERE description IS NULL
       AND notes IS NOT NULL;
  `);

  pgm.sql('ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_work_order_number_key');

  pgm.alterColumn('work_orders', 'number', { notNull: true });
  pgm.createIndex('work_orders', ['tenant_id', 'number'], {
    name: 'idx_work_orders_tenant_number_unique',
    unique: true
  });

  pgm.createTable('work_order_sequences', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'CASCADE' },
    next_number: { type: 'integer', notNull: true }
  });

  pgm.sql(`
    INSERT INTO work_order_sequences (tenant_id, next_number)
    SELECT tenant_id,
           COALESCE(MAX((SUBSTRING(number FROM 'WO-(\\d+)$'))::int), 0) + 1
      FROM work_orders
     GROUP BY tenant_id
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO audit_log (id, tenant_id, occurred_at, actor_type, action, entity_type, entity_id, metadata)
    SELECT gen_random_uuid(),
           tenant_id,
           now(),
           'system',
           'update',
           'work_order',
           id,
           jsonb_build_object('event', 'work_order_number_backfill', 'number', number)
      FROM work_orders
     WHERE number IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('work_order_sequences');
  pgm.dropIndex('work_orders', ['tenant_id', 'number'], { name: 'idx_work_orders_tenant_number_unique' });
  pgm.alterColumn('work_orders', 'number', { notNull: false });
  pgm.addConstraint('work_orders', 'work_orders_work_order_number_key', { unique: ['work_order_number'] });
  pgm.dropColumn('work_orders', ['number', 'description']);
}
