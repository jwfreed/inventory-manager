import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('inventory_adjustments', {
    corrected_from_adjustment_id: {
      type: 'uuid',
      references: 'inventory_adjustments',
      onDelete: 'SET NULL'
    }
  });

  pgm.createIndex('inventory_adjustments', ['corrected_from_adjustment_id'], {
    name: 'idx_inventory_adjustments_corrected_from'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_adjustments', ['corrected_from_adjustment_id'], {
    name: 'idx_inventory_adjustments_corrected_from'
  });
  pgm.dropColumn('inventory_adjustments', 'corrected_from_adjustment_id');
}
