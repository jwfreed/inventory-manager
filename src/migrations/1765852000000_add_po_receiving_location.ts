import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('purchase_orders', {
    receiving_location_id: { type: 'uuid', references: 'locations' }
  });
  pgm.createIndex('purchase_orders', 'receiving_location_id', {
    name: 'idx_po_receiving_location_id'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('purchase_orders', 'receiving_location_id', { name: 'idx_po_receiving_location_id' });
  pgm.dropColumn('purchase_orders', 'receiving_location_id');
}
