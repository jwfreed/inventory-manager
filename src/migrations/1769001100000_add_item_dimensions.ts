import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('items', {
    weight: { type: 'decimal', notNull: false },
    weight_uom: { type: 'varchar(50)', notNull: false },
    volume: { type: 'decimal', notNull: false },
    volume_uom: { type: 'varchar(50)', notNull: false }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('items', ['weight', 'weight_uom', 'volume', 'volume_uom']);
}
