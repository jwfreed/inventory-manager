import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('vendors', {
    contact_name: { type: 'text', notNull: false },
    notes: { type: 'text', notNull: false },
  });

  pgm.addColumns('items', {
    is_purchasable: { type: 'boolean', notNull: true, default: true },
    is_manufactured: { type: 'boolean', notNull: true, default: false },
  });

  pgm.sql(`
    UPDATE items
       SET is_purchasable = CASE
             WHEN type IN ('raw', 'packaging') THEN true
             ELSE false
           END,
           is_manufactured = CASE
             WHEN type IN ('wip', 'finished') THEN true
             ELSE false
           END
  `);

  pgm.createIndex('items', ['tenant_id', 'is_purchasable'], {
    name: 'idx_items_tenant_purchasable',
  });
  pgm.createIndex('items', ['tenant_id', 'is_manufactured'], {
    name: 'idx_items_tenant_manufactured',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('items', ['tenant_id', 'is_manufactured'], {
    name: 'idx_items_tenant_manufactured',
    ifExists: true,
  });
  pgm.dropIndex('items', ['tenant_id', 'is_purchasable'], {
    name: 'idx_items_tenant_purchasable',
    ifExists: true,
  });
  pgm.dropColumns('items', ['is_purchasable', 'is_manufactured']);
  pgm.dropColumns('vendors', ['contact_name', 'notes']);
}
