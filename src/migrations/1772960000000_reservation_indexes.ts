import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Supports open-commitment aggregation at the exact reservation grain (tenant/item/location/uom/status).
  pgm.createIndex('inventory_reservations', ['tenant_id', 'item_id', 'location_id', 'uom', 'status'], {
    name: 'idx_reservations_tenant_item_loc_uom_status',
    ifNotExists: true
  });

  // Supports reservation expiry scans (status + expires_at) used by expireReservationsJob.
  pgm.createIndex('inventory_reservations', ['status', 'expires_at'], {
    name: 'idx_reservations_status_expires_at',
    ifNotExists: true,
    where: "status = 'RESERVED' AND expires_at IS NOT NULL"
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_reservations', [], {
    name: 'idx_reservations_status_expires_at',
    ifExists: true
  });
  pgm.dropIndex('inventory_reservations', [], {
    name: 'idx_reservations_tenant_item_loc_uom_status',
    ifExists: true
  });
}
