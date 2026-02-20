import type { MigrationBuilder } from 'node-pg-migrate';

const POST_EXEC_STATUS = "('IN_PROGRESS','SUCCEEDED','FAILED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('cycle_counts', {
    warehouse_id: { type: 'uuid', references: 'locations' }
  });

  pgm.sql(`
    UPDATE cycle_counts
       SET warehouse_id = resolve_warehouse_for_location(tenant_id, location_id)
     WHERE warehouse_id IS NULL
       AND location_id IS NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE cycle_counts
      ADD CONSTRAINT chk_cycle_counts_warehouse_required
      CHECK (warehouse_id IS NOT NULL)
      NOT VALID;
  `);

  pgm.createIndex('cycle_counts', ['tenant_id', 'warehouse_id', 'status'], {
    name: 'idx_cycle_counts_tenant_warehouse_status'
  });

  pgm.addColumns('cycle_count_lines', {
    location_id: { type: 'uuid', references: 'locations' },
    unit_cost_for_positive_adjustment: { type: 'numeric(18,6)' }
  });

  pgm.sql(`
    UPDATE cycle_count_lines l
       SET location_id = c.location_id
      FROM cycle_counts c
     WHERE c.id = l.cycle_count_id
       AND c.tenant_id = l.tenant_id
       AND l.location_id IS NULL;
  `);

  pgm.alterColumn('cycle_count_lines', 'location_id', {
    notNull: true
  });

  pgm.sql(`
    ALTER TABLE cycle_count_lines
      ADD CONSTRAINT chk_cycle_count_lines_positive_unit_cost_nonnegative
      CHECK (unit_cost_for_positive_adjustment IS NULL OR unit_cost_for_positive_adjustment >= 0);
  `);

  pgm.dropConstraint('cycle_count_lines', 'uq_cycle_count_lines_item_uom', { ifExists: true });
  pgm.addConstraint('cycle_count_lines', 'uq_cycle_count_lines_item_location_uom', {
    unique: ['cycle_count_id', 'item_id', 'location_id', 'uom']
  });

  pgm.createTable('cycle_count_post_executions', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    cycle_count_id: { type: 'uuid', notNull: true, references: 'cycle_counts', onDelete: 'CASCADE' },
    idempotency_key: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    request_summary: { type: 'jsonb' },
    status: { type: 'text', notNull: true, default: 'IN_PROGRESS' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('cycle_count_post_executions', 'chk_cycle_count_post_exec_status', {
    check: `status IN ${POST_EXEC_STATUS}`
  });

  pgm.addConstraint('cycle_count_post_executions', 'uq_cycle_count_post_exec_idempotency', {
    unique: ['tenant_id', 'idempotency_key']
  });

  pgm.createIndex('cycle_count_post_executions', ['tenant_id', 'cycle_count_id'], {
    name: 'idx_cycle_count_post_exec_tenant_count'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('cycle_count_post_executions', ['tenant_id', 'cycle_count_id'], {
    name: 'idx_cycle_count_post_exec_tenant_count',
    ifExists: true
  });
  pgm.dropConstraint('cycle_count_post_executions', 'uq_cycle_count_post_exec_idempotency', { ifExists: true });
  pgm.dropConstraint('cycle_count_post_executions', 'chk_cycle_count_post_exec_status', { ifExists: true });
  pgm.dropTable('cycle_count_post_executions', { ifExists: true });

  pgm.dropConstraint('cycle_count_lines', 'uq_cycle_count_lines_item_location_uom', { ifExists: true });
  pgm.addConstraint('cycle_count_lines', 'uq_cycle_count_lines_item_uom', {
    unique: ['cycle_count_id', 'item_id', 'uom']
  });

  pgm.sql('ALTER TABLE cycle_count_lines DROP CONSTRAINT IF EXISTS chk_cycle_count_lines_positive_unit_cost_nonnegative;');
  pgm.dropColumns('cycle_count_lines', ['unit_cost_for_positive_adjustment', 'location_id'], {
    ifExists: true
  });

  pgm.dropIndex('cycle_counts', ['tenant_id', 'warehouse_id', 'status'], {
    name: 'idx_cycle_counts_tenant_warehouse_status',
    ifExists: true
  });
  pgm.sql('ALTER TABLE cycle_counts DROP CONSTRAINT IF EXISTS chk_cycle_counts_warehouse_required;');
  pgm.dropColumns('cycle_counts', ['warehouse_id'], { ifExists: true });
}
