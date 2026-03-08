import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('work_order_wip_valuation_records', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    work_order_id: { type: 'uuid', notNull: true, references: 'work_orders' },
    work_order_execution_id: { type: 'uuid', references: 'work_order_executions', onDelete: 'SET NULL' },
    inventory_movement_id: { type: 'uuid', notNull: true, references: 'inventory_movements' },
    valuation_type: { type: 'text', notNull: true },
    value_delta: { type: 'numeric(18,6)', notNull: true },
    quantity_canonical: { type: 'numeric(24,12)' },
    canonical_uom: { type: 'text' },
    cost_method: { type: 'text' },
    reversal_of_valuation_record_id: {
      type: 'uuid',
      references: 'work_order_wip_valuation_records',
      onDelete: 'SET NULL'
    },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'work_order_wip_valuation_records',
    'chk_work_order_wip_valuation_type',
    "CHECK (valuation_type IN ('issue','completion','report','reversal_to_wip','reversal_from_wip'))"
  );
  pgm.addConstraint(
    'work_order_wip_valuation_records',
    'chk_work_order_wip_valuation_cost_method',
    "CHECK (cost_method IS NULL OR cost_method = 'fifo')"
  );
  pgm.addConstraint(
    'work_order_wip_valuation_records',
    'chk_work_order_wip_valuation_quantity_nonnegative',
    'CHECK (quantity_canonical IS NULL OR quantity_canonical >= 0)'
  );
  pgm.addConstraint(
    'work_order_wip_valuation_records',
    'chk_work_order_wip_valuation_canonical_uom_required',
    'CHECK ((quantity_canonical IS NULL AND canonical_uom IS NULL) OR (quantity_canonical IS NOT NULL AND canonical_uom IS NOT NULL))'
  );

  pgm.createIndex(
    'work_order_wip_valuation_records',
    ['tenant_id', 'inventory_movement_id', 'valuation_type'],
    {
      name: 'uq_work_order_wip_valuation_movement_type',
      unique: true
    }
  );
  pgm.createIndex('work_order_wip_valuation_records', ['tenant_id', 'work_order_id', 'created_at'], {
    name: 'idx_work_order_wip_valuation_work_order'
  });
  pgm.createIndex(
    'work_order_wip_valuation_records',
    ['tenant_id', 'work_order_execution_id', 'created_at'],
    {
      name: 'idx_work_order_wip_valuation_execution'
    }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex(
    'work_order_wip_valuation_records',
    ['tenant_id', 'work_order_execution_id', 'created_at'],
    { name: 'idx_work_order_wip_valuation_execution', ifExists: true }
  );
  pgm.dropIndex(
    'work_order_wip_valuation_records',
    ['tenant_id', 'work_order_id', 'created_at'],
    { name: 'idx_work_order_wip_valuation_work_order', ifExists: true }
  );
  pgm.dropIndex(
    'work_order_wip_valuation_records',
    ['tenant_id', 'inventory_movement_id', 'valuation_type'],
    { name: 'uq_work_order_wip_valuation_movement_type', ifExists: true }
  );
  pgm.dropConstraint(
    'work_order_wip_valuation_records',
    'chk_work_order_wip_valuation_canonical_uom_required',
    { ifExists: true }
  );
  pgm.dropConstraint('work_order_wip_valuation_records', 'chk_work_order_wip_valuation_quantity_nonnegative', {
    ifExists: true
  });
  pgm.dropConstraint('work_order_wip_valuation_records', 'chk_work_order_wip_valuation_cost_method', {
    ifExists: true
  });
  pgm.dropConstraint('work_order_wip_valuation_records', 'chk_work_order_wip_valuation_type', {
    ifExists: true
  });
  pgm.dropTable('work_order_wip_valuation_records');
}
