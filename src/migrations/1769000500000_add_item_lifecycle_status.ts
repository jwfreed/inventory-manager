import { MigrationBuilder } from 'node-pg-migrate';

const TABLE_NAME = 'items';
const COLUMN_NAME = 'lifecycle_status';
const CONSTRAINT_NAME = 'items_lifecycle_status_check';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn(TABLE_NAME, {
    [COLUMN_NAME]: {
      type: 'text',
      notNull: true,
      default: 'Active',
      check: `(${COLUMN_NAME} IN ('Active', 'In-Development', 'Obsolete', 'Phase-Out'))`,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn(TABLE_NAME, COLUMN_NAME);
}
