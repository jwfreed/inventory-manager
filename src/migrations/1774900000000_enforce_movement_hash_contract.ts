import type { MigrationBuilder } from 'node-pg-migrate';

const HASH_COMMENT =
  'Deterministic SHA-256 fingerprint of authoritative movement envelope fields and sorted ledger lines; required for every authoritative inventory movement.';

const LEGACY_HASH_COMMENT =
  'Deterministic SHA-256 fingerprint of authoritative movement envelope fields and sorted ledger lines.';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    COMMENT ON COLUMN inventory_movements.movement_deterministic_hash
      IS '${HASH_COMMENT}';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    COMMENT ON COLUMN inventory_movements.movement_deterministic_hash
      IS '${LEGACY_HASH_COMMENT}';
  `);
}
