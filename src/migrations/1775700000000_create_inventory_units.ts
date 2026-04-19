import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_units', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    sku_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'RESTRICT' },
    lot_id: { type: 'uuid', references: 'lots', onDelete: 'RESTRICT' },
    lot_key: { type: 'text', notNull: true },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    unit_of_measure: { type: 'text', notNull: true },
    state: { type: 'text', notNull: true },
    record_quantity: { type: 'numeric(18,6)', notNull: true },
    physical_quantity: { type: 'numeric(18,6)' },
    first_event_timestamp: { type: 'timestamptz', notNull: true },
    last_event_timestamp: { type: 'timestamptz', notNull: true },
    last_event_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'inventory_units',
    'chk_inventory_units_state',
    "CHECK (state IN ('received','qc_hold','available','allocated','picked','shipped','adjusted'))"
  );
  pgm.addConstraint('inventory_units', 'chk_inventory_units_record_nonnegative', 'CHECK (record_quantity >= 0)');
  pgm.addConstraint(
    'inventory_units',
    'chk_inventory_units_physical_nonnegative',
    'CHECK (physical_quantity IS NULL OR physical_quantity >= 0)'
  );
  pgm.addConstraint(
    'inventory_units',
    'chk_inventory_units_uom_not_blank',
    "CHECK (btrim(unit_of_measure) <> '')"
  );
  pgm.addConstraint(
    'inventory_units',
    'uq_inventory_units_scope',
    'UNIQUE (tenant_id, sku_id, lot_key, location_id, unit_of_measure)'
  );
  pgm.createIndex('inventory_units', ['tenant_id', 'sku_id', 'location_id', 'unit_of_measure'], {
    name: 'idx_inventory_units_scope'
  });
  pgm.createIndex(
    'inventory_units',
    ['tenant_id', 'sku_id', 'location_id', 'unit_of_measure', 'state', 'first_event_timestamp', 'id'],
    {
      name: 'idx_inventory_units_fifo_available',
      where: "record_quantity > 0 AND state = 'available'"
    }
  );

  pgm.createTable('inventory_unit_events', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    inventory_unit_id: { type: 'uuid', notNull: true },
    movement_id: { type: 'uuid', notNull: true, references: 'inventory_movements', onDelete: 'RESTRICT' },
    movement_line_id: { type: 'uuid', notNull: true, references: 'inventory_movement_lines', onDelete: 'RESTRICT' },
    source_line_id: { type: 'text', notNull: true },
    sku_id: { type: 'uuid', notNull: true, references: 'items', onDelete: 'RESTRICT' },
    lot_id: { type: 'uuid', references: 'lots', onDelete: 'RESTRICT' },
    lot_key: { type: 'text', notNull: true },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    unit_of_measure: { type: 'text', notNull: true },
    event_timestamp: { type: 'timestamptz', notNull: true },
    recorded_at: { type: 'timestamptz', notNull: true },
    reason_code: { type: 'text', notNull: true },
    state_transition: { type: 'text', notNull: true },
    record_quantity_delta: { type: 'numeric(18,6)', notNull: true },
    physical_quantity_delta: { type: 'numeric(18,6)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'inventory_unit_events',
    'chk_inventory_unit_events_transition',
    `CHECK (state_transition IN (
      'received->qc_hold',
      'received->available',
      'qc_hold->available',
      'available->allocated',
      'allocated->available',
      'allocated->picked',
      'picked->shipped',
      'available->shipped',
      'available->adjusted',
      'adjusted->available'
    ))`
  );
  pgm.addConstraint(
    'inventory_unit_events',
    'chk_inventory_unit_events_qty_nonzero',
    'CHECK (record_quantity_delta <> 0)'
  );
  pgm.addConstraint(
    'inventory_unit_events',
    'chk_inventory_unit_events_reason_not_blank',
    "CHECK (btrim(reason_code) <> '')"
  );
  pgm.addConstraint(
    'inventory_unit_events',
    'chk_inventory_unit_events_source_line_not_blank',
    "CHECK (btrim(source_line_id) <> '')"
  );
  pgm.addConstraint(
    'inventory_unit_events',
    'chk_inventory_unit_events_uom_not_blank',
    "CHECK (btrim(unit_of_measure) <> '')"
  );
  pgm.addConstraint(
    'inventory_unit_events',
    'uq_inventory_unit_events_line_unit',
    'UNIQUE (tenant_id, movement_line_id, inventory_unit_id)'
  );
  pgm.createIndex('inventory_unit_events', ['tenant_id', 'event_timestamp', 'id'], {
    name: 'idx_inventory_unit_events_replay'
  });
  pgm.createIndex(
    'inventory_unit_events',
    ['tenant_id', 'sku_id', 'location_id', 'unit_of_measure', 'event_timestamp', 'id'],
    { name: 'idx_inventory_unit_events_fifo_scope' }
  );

  pgm.sql(`
    CREATE TRIGGER inventory_unit_events_no_update
      BEFORE UPDATE ON inventory_unit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
  `);
  pgm.sql(`
    CREATE TRIGGER inventory_unit_events_no_delete
      BEFORE DELETE ON inventory_unit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS inventory_unit_events_no_delete ON inventory_unit_events;');
  pgm.sql('DROP TRIGGER IF EXISTS inventory_unit_events_no_update ON inventory_unit_events;');
  pgm.dropTable('inventory_unit_events');
  pgm.dropTable('inventory_units');
}
