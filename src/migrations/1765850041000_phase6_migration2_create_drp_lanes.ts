import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_lanes', {
    id: { type: 'uuid', primaryKey: true },
    from_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    transfer_lead_time_days: { type: 'integer', notNull: true },
    active: { type: 'boolean', notNull: true, default: pgm.func('true') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('drp_lanes', 'chk_drp_lanes_nodes', {
    check: 'from_node_id <> to_node_id'
  });
  pgm.addConstraint('drp_lanes', 'chk_drp_lanes_lead_time', {
    check: 'transfer_lead_time_days >= 0'
  });

  pgm.createIndex('drp_lanes', ['from_node_id', 'to_node_id'], {
    name: 'idx_drp_lanes_pair',
    unique: true
  });
  pgm.createIndex('drp_lanes', ['to_node_id', 'active'], { name: 'idx_drp_lanes_to_node' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_lanes');
}

