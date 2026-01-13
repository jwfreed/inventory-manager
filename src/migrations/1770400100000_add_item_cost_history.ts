import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create cost history table for audit trail and stale cost detection
  pgm.createTable('item_cost_history', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    item_id: {
      type: 'uuid',
      notNull: true,
      comment: 'Reference to the item whose cost was updated.'
    },
    cost_type: {
      type: 'text',
      notNull: true,
      comment: "Type of cost that was updated: 'standard', 'rolled', or 'avg'."
    },
    old_value: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Previous cost value. NULL if this was the first time cost was set.'
    },
    new_value: {
      type: 'numeric(18,6)',
      notNull: true,
      comment: 'New cost value after the update.'
    },
    calculated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
      comment: 'Timestamp when the cost was calculated/updated.'
    },
    calculated_by: {
      type: 'uuid',
      notNull: false,
      comment: 'User ID who triggered the cost calculation. NULL for system-calculated costs.'
    },
    bom_version_id: {
      type: 'uuid',
      notNull: false,
      comment: 'BOM version used for rolled cost calculation. NULL for standard/avg costs.'
    },
    component_snapshot: {
      type: 'jsonb',
      notNull: false,
      comment: 'Snapshot of component costs used in rolled cost calculation. Enables stale cost detection.'
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // Add foreign key constraints
  pgm.addConstraint('item_cost_history', 'fk_item_cost_history_item', {
    foreignKeys: {
      columns: 'item_id',
      references: 'items',
      onDelete: 'CASCADE'
    }
  });

  pgm.addConstraint('item_cost_history', 'fk_item_cost_history_bom_version', {
    foreignKeys: {
      columns: 'bom_version_id',
      references: 'bom_versions(id)',
      onDelete: 'SET NULL'
    }
  });

  // Add check constraints
  pgm.addConstraint('item_cost_history', 'chk_item_cost_history_cost_type', 
    "CHECK (cost_type IN ('standard', 'rolled', 'avg'))");
  
  pgm.addConstraint('item_cost_history', 'chk_item_cost_history_old_value_nonnegative', 
    'CHECK (old_value IS NULL OR old_value >= 0)');
  
  pgm.addConstraint('item_cost_history', 'chk_item_cost_history_new_value_nonnegative', 
    'CHECK (new_value >= 0)');

  // Add indexes for efficient querying
  pgm.createIndex('item_cost_history', ['item_id', 'calculated_at'], {
    name: 'idx_item_cost_history_item_date'
  });

  pgm.createIndex('item_cost_history', 'bom_version_id', {
    name: 'idx_item_cost_history_bom_version',
    where: 'bom_version_id IS NOT NULL'
  });

  pgm.createIndex('item_cost_history', 'cost_type', {
    name: 'idx_item_cost_history_cost_type'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('item_cost_history');
}
