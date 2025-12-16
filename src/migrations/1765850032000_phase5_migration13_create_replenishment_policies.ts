import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('replenishment_policies', {
    id: { type: 'uuid', primaryKey: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    policy_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    lead_time_days: { type: 'integer' },
    demand_rate_per_day: { type: 'numeric(18,6)' },
    safety_stock_method: { type: 'text', notNull: true },
    safety_stock_qty: { type: 'numeric(18,6)' },
    ppis_periods: { type: 'integer' },
    review_period_days: { type: 'integer' },
    order_up_to_level_qty: { type: 'numeric(18,6)' },
    reorder_point_qty: { type: 'numeric(18,6)' },
    order_quantity_qty: { type: 'numeric(18,6)' },
    min_order_qty: { type: 'numeric(18,6)' },
    max_order_qty: { type: 'numeric(18,6)' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('replenishment_policies', 'unique_replenishment_policy_scope', {
    unique: ['item_id', 'uom', 'site_location_id']
  });
  pgm.addConstraint('replenishment_policies', 'chk_replenishment_policy_type', {
    check: "policy_type IN ('q_rop','t_oul')"
  });
  pgm.addConstraint('replenishment_policies', 'chk_replenishment_policy_status', {
    check: "status IN ('active','inactive')"
  });
  pgm.addConstraint('replenishment_policies', 'chk_replenishment_policy_safety_method', {
    check: "safety_stock_method IN ('none','fixed','ppis')"
  });
  pgm.addConstraint('replenishment_policies', 'chk_replenishment_policy_numbers', {
    check:
      '(lead_time_days IS NULL OR lead_time_days >= 0) AND ' +
      '(demand_rate_per_day IS NULL OR demand_rate_per_day >= 0) AND ' +
      '(safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND ' +
      '(ppis_periods IS NULL OR ppis_periods > 0) AND ' +
      '(review_period_days IS NULL OR review_period_days > 0) AND ' +
      '(order_up_to_level_qty IS NULL OR order_up_to_level_qty >= 0) AND ' +
      '(reorder_point_qty IS NULL OR reorder_point_qty >= 0) AND ' +
      '(order_quantity_qty IS NULL OR order_quantity_qty > 0) AND ' +
      '(min_order_qty IS NULL OR min_order_qty >= 0) AND ' +
      '(max_order_qty IS NULL OR max_order_qty >= 0)'
  });

  pgm.createIndex('replenishment_policies', 'status', { name: 'idx_replenishment_policies_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('replenishment_policies');
}

