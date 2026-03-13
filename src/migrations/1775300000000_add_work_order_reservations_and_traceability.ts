import type { MigrationBuilder } from 'node-pg-migrate';

const RESERVATION_DEMAND_TYPES = "('sales_order_line','work_order_component')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_reservation_demand_type;

    ALTER TABLE inventory_reservations
      ADD CONSTRAINT chk_reservation_demand_type
      CHECK (demand_type IN ${RESERVATION_DEMAND_TYPES});
  `);

  pgm.addColumns('inventory_movements', {
    production_batch_id: { type: 'text' },
    lot_id: { type: 'uuid', references: 'lots', onDelete: 'SET NULL' }
  });

  pgm.addColumns('work_order_executions', {
    production_batch_id: { type: 'text' },
    output_lot_id: { type: 'uuid', references: 'lots', onDelete: 'SET NULL' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('work_order_executions', ['production_batch_id', 'output_lot_id'], { ifExists: true });
  pgm.dropColumns('inventory_movements', ['production_batch_id', 'lot_id'], { ifExists: true });

  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_reservation_demand_type;

    ALTER TABLE inventory_reservations
      ADD CONSTRAINT chk_reservation_demand_type
      CHECK (demand_type = 'sales_order_line');
  `);
}
