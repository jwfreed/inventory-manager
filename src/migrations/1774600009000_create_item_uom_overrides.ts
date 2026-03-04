import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('item_uom_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'CASCADE' },
    from_uom: { type: 'text', notNull: true },
    to_uom: { type: 'text', notNull: true },
    multiplier: { type: 'numeric(24,12)', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('item_uom_overrides', 'chk_item_uom_overrides_from_not_blank', "CHECK (trim(from_uom) <> '')");
  pgm.addConstraint('item_uom_overrides', 'chk_item_uom_overrides_to_not_blank', "CHECK (trim(to_uom) <> '')");
  pgm.addConstraint('item_uom_overrides', 'chk_item_uom_overrides_positive_multiplier', 'CHECK (multiplier > 0)');
  pgm.addConstraint('item_uom_overrides', 'chk_item_uom_overrides_not_self', 'CHECK (from_uom <> to_uom)');
  pgm.createIndex('item_uom_overrides', ['tenant_id', 'item_id'], {
    name: 'idx_item_uom_overrides_tenant_item'
  });
  pgm.createIndex('item_uom_overrides', ['tenant_id', 'item_id', 'from_uom', 'to_uom'], {
    name: 'idx_item_uom_overrides_unique_active',
    unique: true,
    where: 'active = true'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('item_uom_overrides', { ifExists: true, cascade: true });
}
