import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Drop legacy constraint (created when table was named 'packs')
  pgm.dropConstraint('shipment_containers', 'chk_packs_status');

  // Add column before constraint so the constraint can reference it if needed
  pgm.addColumn('shipment_containers', {
    shipped_at: { type: 'timestamptz' }
  });

  // Re-add constraint with 'shipped' included
  pgm.addConstraint('shipment_containers', 'chk_shipment_containers_status', {
    check: "status IN ('open','sealed','canceled','shipped')"
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('shipment_containers', 'chk_shipment_containers_status');
  pgm.dropColumn('shipment_containers', 'shipped_at');
  pgm.addConstraint('shipment_containers', 'chk_packs_status', {
    check: "status IN ('open','sealed','canceled')"
  });
}
