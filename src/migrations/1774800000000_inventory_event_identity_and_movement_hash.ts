import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex(
    'inventory_events',
    ['tenant_id', 'aggregate_type', 'aggregate_id', 'event_version'],
    {
      name: 'uq_inventory_events_stream_version',
      ifExists: true
    }
  );

  pgm.createIndex(
    'inventory_events',
    ['tenant_id', 'aggregate_type', 'aggregate_id', 'event_type', 'event_version'],
    {
      name: 'uq_inventory_events_identity_version',
      unique: true
    }
  );

  pgm.addColumns('inventory_movements', {
    movement_deterministic_hash: {
      type: 'text',
      comment:
        'Deterministic SHA-256 fingerprint of authoritative movement envelope fields and sorted ledger lines.'
    }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('inventory_movements', ['movement_deterministic_hash'], {
    ifExists: true
  });

  pgm.dropIndex(
    'inventory_events',
    ['tenant_id', 'aggregate_type', 'aggregate_id', 'event_type', 'event_version'],
    {
      name: 'uq_inventory_events_identity_version',
      ifExists: true
    }
  );

  pgm.createIndex(
    'inventory_events',
    ['tenant_id', 'aggregate_type', 'aggregate_id', 'event_version'],
    {
      name: 'uq_inventory_events_stream_version',
      unique: true
    }
  );
}
