import type { MigrationBuilder } from 'node-pg-migrate';
import { ensureCheckConstraintIfMissingOrFail } from './helpers/constraints';

const ROLE_WHITELIST_CHECK =
  "role IS NULL OR role IN ('SELLABLE','QA','HOLD','REJECT','SCRAP')";
const ROLE_SELLABLE_CONSISTENCY_CHECK =
  "role IS NULL OR ((role = 'SELLABLE') = is_sellable)";
const ROLE_REQUIRED_EXCEPT_WAREHOUSE_ROOT_CHECK =
  "role IS NOT NULL OR (type = 'warehouse' AND parent_location_id IS NULL)";
const ORPHAN_IS_WAREHOUSE_ROOT_CHECK =
  '(parent_location_id IS NOT NULL) OR (type = \'warehouse\')';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // We intentionally rely on whitelist semantics for no-line-side policy.
  // If role check allows only canonical roles, LINE_SIDE/STAGING cannot be created.
  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_no_line_side;
  `);

  ensureCheckConstraintIfMissingOrFail(pgm, {
    table: 'locations',
    constraintName: 'chk_locations_role',
    checkExpression: ROLE_WHITELIST_CHECK
  });

  ensureCheckConstraintIfMissingOrFail(pgm, {
    table: 'locations',
    constraintName: 'chk_locations_role_sellable',
    checkExpression: ROLE_SELLABLE_CONSISTENCY_CHECK
  });

  ensureCheckConstraintIfMissingOrFail(pgm, {
    table: 'locations',
    constraintName: 'chk_locations_role_required_except_warehouse_root',
    checkExpression: ROLE_REQUIRED_EXCEPT_WAREHOUSE_ROOT_CHECK
  });

  ensureCheckConstraintIfMissingOrFail(pgm, {
    table: 'locations',
    constraintName: 'chk_locations_orphan_is_warehouse',
    checkExpression: ORPHAN_IS_WAREHOUSE_ROOT_CHECK
  });
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // No-op by design:
  // this migration is a hardening assertion pass and should not rollback constraints.
}
