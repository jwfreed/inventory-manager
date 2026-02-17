import type { MigrationBuilder } from 'node-pg-migrate';

const MOVEMENT_TYPE_VALUES = "('receive','issue','transfer','adjustment','count','receipt_reversal')";
const MOVEMENT_TYPE_VALUES_PREVIOUS = "('receive','issue','transfer','adjustment','count')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('inventory_movements', {
    reversal_of_movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'RESTRICT'
    },
    reversed_by_movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'RESTRICT'
    },
    reversal_reason: { type: 'text' }
  });

  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_of_not_self',
    'CHECK (reversal_of_movement_id IS NULL OR reversal_of_movement_id <> id)'
  );

  pgm.createIndex('inventory_movements', ['tenant_id', 'reversal_of_movement_id'], {
    name: 'uq_inventory_movements_reversal_of',
    unique: true,
    where: 'reversal_of_movement_id IS NOT NULL'
  });

  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_type', { ifExists: true });
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_type',
    `CHECK (movement_type IN ${MOVEMENT_TYPE_VALUES})`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_type', { ifExists: true });
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_type',
    `CHECK (movement_type IN ${MOVEMENT_TYPE_VALUES_PREVIOUS})`
  );

  pgm.dropIndex('inventory_movements', ['tenant_id', 'reversal_of_movement_id'], {
    name: 'uq_inventory_movements_reversal_of',
    ifExists: true
  });

  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_of_not_self', { ifExists: true });
  pgm.dropColumns('inventory_movements', ['reversal_reason', 'reversed_by_movement_id', 'reversal_of_movement_id'], {
    ifExists: true
  });
}
