import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Rename tables
  pgm.renameTable('packs', 'shipment_containers');
  pgm.renameTable('pack_lines', 'shipment_container_items');

  // Update shipment_containers columns
  pgm.addColumns('shipment_containers', {
    tracking_number: { type: 'varchar(255)' },
    sales_order_id: { type: 'uuid', references: 'sales_orders' }
  });
  pgm.alterColumn('shipment_containers', 'sales_order_shipment_id', { notNull: false });

  // Update shipment_container_items columns
  pgm.renameColumn('shipment_container_items', 'pack_id', 'shipment_container_id');
  pgm.renameColumn('shipment_container_items', 'quantity_packed', 'quantity');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Revert shipment_container_items columns
  pgm.renameColumn('shipment_container_items', 'quantity', 'quantity_packed');
  pgm.renameColumn('shipment_container_items', 'shipment_container_id', 'pack_id');

  // Revert shipment_containers columns
  pgm.alterColumn('shipment_containers', 'sales_order_shipment_id', { notNull: true });
  pgm.dropColumns('shipment_containers', ['tracking_number', 'sales_order_id']);

  // Rename tables back
  pgm.renameTable('shipment_container_items', 'pack_lines');
  pgm.renameTable('shipment_containers', 'packs');
}
