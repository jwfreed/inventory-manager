import { MigrationBuilder } from 'node-pg-migrate';

const TABLE_NAME = 'uom_conversions';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(TABLE_NAME, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true },
    item_id: {
      type: 'uuid',
      notNull: true,
      references: 'items(id)',
      onDelete: 'CASCADE',
    },
    from_uom: { type: 'text', notNull: true },
    to_uom: { type: 'text', notNull: true },
    factor: { type: 'decimal(18, 9)', notNull: true },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex(TABLE_NAME, ['tenant_id', 'item_id']);
  pgm.addConstraint(TABLE_NAME, 'uom_conversions_unique_conversion', {
    unique: ['tenant_id', 'item_id', 'from_uom', 'to_uom'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(TABLE_NAME);
}
