import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('replenishment_recommendations', {
    id: { type: 'uuid', primaryKey: true },
    replenishment_policy_id: { type: 'uuid', notNull: true, references: 'replenishment_policies', onDelete: 'CASCADE' },
    as_of: { type: 'timestamptz', notNull: true },
    on_hand_qty: { type: 'numeric(18,6)', notNull: true },
    on_order_qty: { type: 'numeric(18,6)' },
    reserved_qty: { type: 'numeric(18,6)' },
    effective_available_qty: { type: 'numeric(18,6)', notNull: true },
    safety_stock_qty: { type: 'numeric(18,6)', notNull: true },
    recommended_order_qty: { type: 'numeric(18,6)', notNull: true },
    policy_type: { type: 'text', notNull: true },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('replenishment_recommendations', 'unique_replenishment_recommendations_scope', {
    unique: ['replenishment_policy_id', 'as_of']
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('replenishment_recommendations');
}

