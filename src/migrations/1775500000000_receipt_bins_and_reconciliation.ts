import type { MigrationBuilder } from 'node-pg-migrate';

const RECEIPT_RECONCILIATION_TYPE_VALUES = "('POSTING_INTEGRITY','PHYSICAL_COUNT')";
const RECEIPT_RECONCILIATION_STATUS_VALUES = "('OPEN','APPROVED','ADJUSTED')";
const RECEIPT_RECONCILIATION_RESOLUTION_VALUES = "('APPROVAL','ADJUSTMENT')";
const RECEIPT_ALLOCATION_STATUS_VALUES = "('QA','AVAILABLE','HOLD')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_bins', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    warehouse_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'CASCADE' },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    is_default: { type: 'boolean', notNull: true, default: false },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('inventory_bins', ['tenant_id', 'location_id'], {
    name: 'idx_inventory_bins_location'
  });
  pgm.createIndex('inventory_bins', ['tenant_id', 'warehouse_id'], {
    name: 'idx_inventory_bins_warehouse'
  });
  pgm.sql(`
    CREATE UNIQUE INDEX uq_inventory_bins_default_per_location
      ON inventory_bins (tenant_id, location_id)
     WHERE is_default = true;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX uq_inventory_bins_location_code
      ON inventory_bins (tenant_id, location_id, lower(code));
  `);
  pgm.sql(`
    INSERT INTO inventory_bins (
      id, tenant_id, warehouse_id, location_id, code, name, is_default, active, created_at, updated_at
    )
    SELECT gen_random_uuid(),
           l.tenant_id,
           l.warehouse_id,
           l.id,
           CASE
             WHEN l.code IS NULL OR btrim(l.code) = '' THEN 'DEFAULT'
             ELSE l.code || '-DEFAULT'
           END,
           CASE
             WHEN l.name IS NULL OR btrim(l.name) = '' THEN 'Default Bin'
             ELSE l.name || ' Default Bin'
           END,
           true,
           true,
           now(),
           now()
      FROM locations l
     WHERE l.type <> 'warehouse'
    ON CONFLICT DO NOTHING;
  `);

  pgm.addColumns('putaway_lines', {
    from_bin_id: { type: 'uuid', references: 'inventory_bins', onDelete: 'RESTRICT' },
    to_bin_id: { type: 'uuid', references: 'inventory_bins', onDelete: 'RESTRICT' }
  });
  pgm.sql(`
    UPDATE putaway_lines pl
       SET from_bin_id = ib.id
      FROM inventory_bins ib
     WHERE ib.tenant_id = pl.tenant_id
       AND ib.location_id = pl.from_location_id
       AND ib.is_default = true
       AND pl.from_bin_id IS NULL;
  `);
  pgm.sql(`
    UPDATE putaway_lines pl
       SET to_bin_id = ib.id
      FROM inventory_bins ib
     WHERE ib.tenant_id = pl.tenant_id
       AND ib.location_id = pl.to_location_id
       AND ib.is_default = true
       AND pl.to_bin_id IS NULL;
  `);
  pgm.alterColumn('putaway_lines', 'from_bin_id', { notNull: true });
  pgm.alterColumn('putaway_lines', 'to_bin_id', { notNull: true });
  pgm.createIndex('putaway_lines', ['tenant_id', 'from_bin_id'], {
    name: 'idx_putaway_lines_from_bin'
  });
  pgm.createIndex('putaway_lines', ['tenant_id', 'to_bin_id'], {
    name: 'idx_putaway_lines_to_bin'
  });

  pgm.addColumns('qc_events', {
    source_bin_id: { type: 'uuid', references: 'inventory_bins', onDelete: 'RESTRICT' },
    destination_bin_id: { type: 'uuid', references: 'inventory_bins', onDelete: 'RESTRICT' }
  });
  pgm.createIndex('qc_events', ['tenant_id', 'source_bin_id'], {
    name: 'idx_qc_events_source_bin'
  });
  pgm.createIndex('qc_events', ['tenant_id', 'destination_bin_id'], {
    name: 'idx_qc_events_destination_bin'
  });

  pgm.dropConstraint('receipt_allocations', 'receipt_allocations_bin_id_fkey', { ifExists: true });
  pgm.sql(`
    UPDATE receipt_allocations ra
       SET bin_id = ib.id
      FROM inventory_bins ib
     WHERE ib.tenant_id = ra.tenant_id
       AND ib.location_id = COALESCE(ra.bin_id, ra.location_id)
       AND ib.is_default = true;
  `);
  pgm.alterColumn('receipt_allocations', 'bin_id', { notNull: true });
  pgm.addConstraint('receipt_allocations', 'receipt_allocations_bin_id_fkey', {
    foreignKeys: {
      columns: 'bin_id',
      references: 'inventory_bins(id)',
      onDelete: 'RESTRICT'
    }
  });
  pgm.createIndex('receipt_allocations', ['tenant_id', 'bin_id'], {
    name: 'idx_receipt_allocations_bin'
  });

  pgm.createTable('receipt_reconciliation_discrepancies', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_order_receipt_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipts',
      onDelete: 'CASCADE'
    },
    purchase_order_receipt_line_id: {
      type: 'uuid',
      references: 'purchase_order_receipt_lines',
      onDelete: 'CASCADE'
    },
    discrepancy_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    warehouse_id: { type: 'uuid', references: 'locations', onDelete: 'SET NULL' },
    location_id: { type: 'uuid', references: 'locations', onDelete: 'SET NULL' },
    bin_id: { type: 'uuid', references: 'inventory_bins', onDelete: 'SET NULL' },
    allocation_status: { type: 'text' },
    expected_qty: { type: 'numeric(18,6)', notNull: true },
    actual_qty: { type: 'numeric(18,6)', notNull: true },
    discrepancy_qty: { type: 'numeric(18,6)', notNull: true },
    tolerance_qty: { type: 'numeric(18,6)', notNull: true, default: 0 },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    notes: { type: 'text' },
    detected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint(
    'receipt_reconciliation_discrepancies',
    'chk_receipt_reconciliation_discrepancies_type',
    `CHECK (discrepancy_type IN ${RECEIPT_RECONCILIATION_TYPE_VALUES})`
  );
  pgm.addConstraint(
    'receipt_reconciliation_discrepancies',
    'chk_receipt_reconciliation_discrepancies_status',
    `CHECK (status IN ${RECEIPT_RECONCILIATION_STATUS_VALUES})`
  );
  pgm.addConstraint(
    'receipt_reconciliation_discrepancies',
    'chk_receipt_reconciliation_discrepancies_allocation_status',
    `CHECK (allocation_status IS NULL OR allocation_status IN ${RECEIPT_ALLOCATION_STATUS_VALUES})`
  );
  pgm.createIndex('receipt_reconciliation_discrepancies', ['tenant_id', 'purchase_order_receipt_id', 'status'], {
    name: 'idx_receipt_reconciliation_discrepancies_receipt_status'
  });

  pgm.createTable('receipt_reconciliation_resolutions', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    discrepancy_id: {
      type: 'uuid',
      notNull: true,
      references: 'receipt_reconciliation_discrepancies',
      onDelete: 'CASCADE'
    },
    resolution_type: { type: 'text', notNull: true },
    actor_type: { type: 'text' },
    actor_id: { type: 'text' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements', onDelete: 'SET NULL' },
    notes: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint(
    'receipt_reconciliation_resolutions',
    'chk_receipt_reconciliation_resolutions_type',
    `CHECK (resolution_type IN ${RECEIPT_RECONCILIATION_RESOLUTION_VALUES})`
  );
  pgm.addConstraint(
    'receipt_reconciliation_resolutions',
    'chk_receipt_reconciliation_resolutions_actor_type',
    `CHECK (actor_type IS NULL OR actor_type IN ('user','system'))`
  );
  pgm.createIndex('receipt_reconciliation_resolutions', ['tenant_id', 'discrepancy_id'], {
    name: 'idx_receipt_reconciliation_resolutions_discrepancy'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('receipt_reconciliation_resolutions');
  pgm.dropTable('receipt_reconciliation_discrepancies');

  pgm.dropIndex('receipt_allocations', ['tenant_id', 'bin_id'], {
    name: 'idx_receipt_allocations_bin',
    ifExists: true
  });
  pgm.dropConstraint('receipt_allocations', 'receipt_allocations_bin_id_fkey', { ifExists: true });
  pgm.alterColumn('receipt_allocations', 'bin_id', { notNull: false });
  pgm.addConstraint('receipt_allocations', 'receipt_allocations_bin_id_fkey', {
    foreignKeys: {
      columns: 'bin_id',
      references: 'locations(id)',
      onDelete: 'SET NULL'
    }
  });

  pgm.dropIndex('qc_events', ['tenant_id', 'destination_bin_id'], {
    name: 'idx_qc_events_destination_bin',
    ifExists: true
  });
  pgm.dropIndex('qc_events', ['tenant_id', 'source_bin_id'], {
    name: 'idx_qc_events_source_bin',
    ifExists: true
  });
  pgm.dropColumns('qc_events', ['source_bin_id', 'destination_bin_id']);

  pgm.dropIndex('putaway_lines', ['tenant_id', 'to_bin_id'], {
    name: 'idx_putaway_lines_to_bin',
    ifExists: true
  });
  pgm.dropIndex('putaway_lines', ['tenant_id', 'from_bin_id'], {
    name: 'idx_putaway_lines_from_bin',
    ifExists: true
  });
  pgm.dropColumns('putaway_lines', ['from_bin_id', 'to_bin_id']);

  pgm.sql('DROP INDEX IF EXISTS uq_inventory_bins_location_code;');
  pgm.sql('DROP INDEX IF EXISTS uq_inventory_bins_default_per_location;');
  pgm.dropIndex('inventory_bins', ['tenant_id', 'warehouse_id'], {
    name: 'idx_inventory_bins_warehouse',
    ifExists: true
  });
  pgm.dropIndex('inventory_bins', ['tenant_id', 'location_id'], {
    name: 'idx_inventory_bins_location',
    ifExists: true
  });
  pgm.dropTable('inventory_bins');
}
