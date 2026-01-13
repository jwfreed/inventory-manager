import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('work_order_executions', {
    wip_total_cost: {
      type: 'numeric(18,6)',
      comment: 'Total WIP cost allocated to this execution (FIFO).'
    },
    wip_unit_cost: {
      type: 'numeric(18,6)',
      comment: 'WIP unit cost per canonical unit for produced quantity in this execution.'
    },
    wip_quantity_canonical: {
      type: 'numeric(24,12)',
      comment: 'Produced quantity in canonical units for this execution.'
    },
    wip_cost_method: {
      type: 'text',
      comment: "Costing method used for WIP valuation (currently 'fifo')."
    },
    wip_costed_at: {
      type: 'timestamptz',
      comment: 'Timestamp when WIP cost was calculated and persisted.'
    }
  });

  pgm.addConstraint(
    'work_order_executions',
    'chk_work_order_executions_wip_cost_method',
    "CHECK (wip_cost_method IS NULL OR wip_cost_method = 'fifo')"
  );

  pgm.addConstraint(
    'work_order_executions',
    'chk_work_order_executions_wip_cost_nonnegative',
    'CHECK ((wip_total_cost IS NULL OR wip_total_cost >= 0) AND (wip_unit_cost IS NULL OR wip_unit_cost >= 0) AND (wip_quantity_canonical IS NULL OR wip_quantity_canonical >= 0))'
  );

  pgm.addColumns('work_orders', {
    wip_total_cost: {
      type: 'numeric(18,6)',
      comment: 'Cumulative WIP cost allocated to completions for this work order.'
    },
    wip_unit_cost: {
      type: 'numeric(18,6)',
      comment: 'Cumulative unit cost per canonical unit for completed quantity (FIFO).'
    },
    wip_quantity_canonical: {
      type: 'numeric(24,12)',
      comment: 'Cumulative completed quantity in canonical units for this work order.'
    },
    wip_cost_method: {
      type: 'text',
      comment: "Costing method used for WIP valuation (currently 'fifo')."
    },
    wip_costed_at: {
      type: 'timestamptz',
      comment: 'Timestamp when WIP cost was last updated for this work order.'
    }
  });

  pgm.addConstraint(
    'work_orders',
    'chk_work_orders_wip_cost_method',
    "CHECK (wip_cost_method IS NULL OR wip_cost_method = 'fifo')"
  );

  pgm.addConstraint(
    'work_orders',
    'chk_work_orders_wip_cost_nonnegative',
    'CHECK ((wip_total_cost IS NULL OR wip_total_cost >= 0) AND (wip_unit_cost IS NULL OR wip_unit_cost >= 0) AND (wip_quantity_canonical IS NULL OR wip_quantity_canonical >= 0))'
  );

  pgm.addColumns('cost_layer_consumptions', {
    wip_execution_id: {
      type: 'uuid',
      references: 'work_order_executions',
      onDelete: 'SET NULL',
      comment: 'Work order execution that allocated this consumption into WIP.'
    },
    wip_allocated_at: {
      type: 'timestamptz',
      comment: 'Timestamp when this consumption was allocated to WIP.'
    }
  });

  pgm.createIndex('cost_layer_consumptions', 'wip_execution_id', {
    name: 'idx_cost_layer_consumptions_wip_execution',
    where: 'wip_execution_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('cost_layer_consumptions', 'idx_cost_layer_consumptions_wip_execution', { ifExists: true });
  pgm.dropColumns('cost_layer_consumptions', ['wip_execution_id', 'wip_allocated_at']);

  pgm.dropConstraint('work_orders', 'chk_work_orders_wip_cost_nonnegative', { ifExists: true });
  pgm.dropConstraint('work_orders', 'chk_work_orders_wip_cost_method', { ifExists: true });
  pgm.dropColumns('work_orders', [
    'wip_total_cost',
    'wip_unit_cost',
    'wip_quantity_canonical',
    'wip_cost_method',
    'wip_costed_at'
  ]);

  pgm.dropConstraint('work_order_executions', 'chk_work_order_executions_wip_cost_nonnegative', { ifExists: true });
  pgm.dropConstraint('work_order_executions', 'chk_work_order_executions_wip_cost_method', { ifExists: true });
  pgm.dropColumns('work_order_executions', [
    'wip_total_cost',
    'wip_unit_cost',
    'wip_quantity_canonical',
    'wip_cost_method',
    'wip_costed_at'
  ]);
}
