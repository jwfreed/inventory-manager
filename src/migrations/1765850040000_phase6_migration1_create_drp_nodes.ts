import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_nodes', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    node_type: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: pgm.func('true') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('drp_nodes', 'chk_drp_nodes_type', {
    check: "node_type IN ('plant','dc','store')"
  });

  pgm.createIndex('drp_nodes', 'location_id', { name: 'idx_drp_nodes_location', unique: true });
  pgm.createIndex('drp_nodes', ['node_type', 'active'], { name: 'idx_drp_nodes_type_active' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_nodes');
}

