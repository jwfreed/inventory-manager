import { type MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('work_orders', {
    default_consume_location_id: {
      type: 'uuid',
      references: '"locations"',
      onDelete: 'SET NULL',
      notNull: false
    },
    default_produce_location_id: {
      type: 'uuid',
      references: '"locations"',
      onDelete: 'SET NULL',
      notNull: false
    }
  });

  pgm.addColumn('work_order_execution_lines', {
    pack_size: {
      type: 'numeric(18,6)',
      notNull: false
    }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('work_order_execution_lines', 'pack_size');
  pgm.dropColumn('work_orders', ['default_consume_location_id', 'default_produce_location_id']);
}
