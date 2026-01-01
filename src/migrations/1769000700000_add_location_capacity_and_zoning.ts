import { MigrationBuilder } from 'node-pg-migrate';

const TABLE_NAME = 'locations';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns(TABLE_NAME, {
    max_weight: { type: 'decimal(18, 4)', notNull: false },
    max_volume: { type: 'decimal(18, 4)', notNull: false },
    zone: { type: 'text', notNull: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns(TABLE_NAME, ['max_weight', 'max_volume', 'zone']);
}
