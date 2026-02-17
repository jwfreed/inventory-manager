import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_type_requires_link',
    "CHECK (movement_type <> 'receipt_reversal' OR reversal_of_movement_id IS NOT NULL)"
  );

  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_link_requires_type',
    "CHECK (reversal_of_movement_id IS NULL OR movement_type = 'receipt_reversal')"
  );

  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_reason_required',
    "CHECK (reversal_of_movement_id IS NULL OR (reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0))"
  );

  pgm.createIndex('inventory_movements', ['tenant_id', 'reversed_by_movement_id'], {
    name: 'uq_inventory_movements_reversed_by',
    unique: true,
    where: 'reversed_by_movement_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movements', ['tenant_id', 'reversed_by_movement_id'], {
    name: 'uq_inventory_movements_reversed_by',
    ifExists: true
  });

  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_reason_required', { ifExists: true });
  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_link_requires_type', { ifExists: true });
  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_type_requires_link', { ifExists: true });
}
