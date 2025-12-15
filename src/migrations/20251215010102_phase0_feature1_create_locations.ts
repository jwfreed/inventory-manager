import type { MigrationBuilder } from 'node-pg-migrate';

const LOCATION_TYPES = "('warehouse','bin','store','customer','vendor','scrap','virtual')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('locations', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('locations', 'type', { name: 'idx_locations_type' });
  pgm.createIndex('locations', 'active', { name: 'idx_locations_active' });
  pgm.addConstraint('locations', 'chk_locations_type', `CHECK (type IN ${LOCATION_TYPES})`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('locations');
}
