import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('inventory_movement_lines', {
    source_line_id: {
      type: 'text',
      comment: 'Deterministic source line identity, unique within a movement. Nullable only for legacy rows.'
    },
    event_timestamp: {
      type: 'timestamp',
      comment: 'Physical event timestamp used for inventory ordering and deterministic rebuild.'
    },
    recorded_at: {
      type: 'timestamp',
      comment: 'System recording timestamp distinct from physical event time.'
    }
  });

  pgm.createIndex(
    'inventory_movement_lines',
    ['movement_id', 'source_line_id'],
    {
      name: 'uq_inventory_movement_lines_movement_source_line',
      unique: true,
      where: 'source_line_id IS NOT NULL'
    }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex(
    'inventory_movement_lines',
    ['movement_id', 'source_line_id'],
    {
      name: 'uq_inventory_movement_lines_movement_source_line',
      ifExists: true
    }
  );

  pgm.dropColumns('inventory_movement_lines', [
    'source_line_id',
    'event_timestamp',
    'recorded_at'
  ], { ifExists: true });
}
