import type { MigrationBuilder } from 'node-pg-migrate';

const IDENTITY_INDEX = 'uq_inventory_movement_lines_movement_source_line';
const NON_EMPTY_CHECK = 'chk_inventory_movement_lines_source_line_nonempty';

// Canonical bodies – must stay in sync with the migrations that created each function.
// 1774300000000_enforce_ledger_immutability.ts
const CANONICAL_PREVENT_LEDGER_MUTATION_BODY = `
BEGIN
  RAISE EXCEPTION 'Ledger tables are append-only. UPDATE/DELETE is not allowed on %', TG_TABLE_NAME;
END;
`;

// 1771400002000_add_inventory_invariants.ts
const CANONICAL_PREVENT_UPDATE_DELETE_POSTED_LINES_BODY = `
DECLARE
  movement_status text;
BEGIN
  SELECT status INTO movement_status FROM inventory_movements WHERE id = OLD.movement_id;
  IF movement_status = 'posted' THEN
    RAISE EXCEPTION 'POSTED_INVENTORY_MOVEMENT_LINE_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // The backfill requires an UPDATE on inventory_movement_lines, which two BEFORE UPDATE
  // triggers block: prevent_ledger_mutation (append-only guard) and
  // prevent_update_delete_posted_inventory_movement_lines (posted-status guard).
  // Temporarily extend both functions to allow this one-time backfill via a
  // transaction-scoped GUC, then restore the canonical bodies before the transaction
  // commits. On failure the whole transaction rolls back, including both function changes.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
    RETURNS trigger AS $fn$
    BEGIN
      IF current_setting('app.ledger_source_line_backfill', true) = '1' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Ledger tables are append-only. UPDATE/DELETE is not allowed on %', TG_TABLE_NAME;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.prevent_update_delete_posted_inventory_movement_lines()
    RETURNS trigger AS $$
    DECLARE
      movement_status text;
    BEGIN
      IF current_setting('app.ledger_source_line_backfill', true) = '1' THEN
        -- For UPDATE return NEW so the updated values take effect;
        -- for DELETE return OLD to allow the delete (NEW is NULL for deletes).
        RETURN COALESCE(NEW, OLD);
      END IF;
      SELECT status INTO movement_status FROM inventory_movements WHERE id = OLD.movement_id;
      IF movement_status = 'posted' THEN
        RAISE EXCEPTION 'POSTED_INVENTORY_MOVEMENT_LINE_IMMUTABLE';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`SET LOCAL app.ledger_source_line_backfill = '1';`);

  pgm.sql(`
    UPDATE inventory_movement_lines
       SET source_line_id = 'syn:' || id::text
     WHERE source_line_id IS NULL
        OR btrim(source_line_id) = '';
  `);

  // Restore both canonical function bodies before the remaining schema changes.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
    RETURNS trigger AS $fn$
    ${CANONICAL_PREVENT_LEDGER_MUTATION_BODY}
    $fn$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.prevent_update_delete_posted_inventory_movement_lines()
    RETURNS trigger AS $$
    ${CANONICAL_PREVENT_UPDATE_DELETE_POSTED_LINES_BODY}
    $$ LANGUAGE plpgsql;
  `);

  // Flush the deferred trg_inventory_transfer_balance constraint trigger that was
  // queued by the backfill UPDATE. This must happen before ALTER TABLE, which cannot
  // run with pending trigger events. The balance constraint is not violated because
  // the backfill only changes source_line_id, not any quantity fields.
  pgm.sql('SET CONSTRAINTS ALL IMMEDIATE;');

  pgm.alterColumn('inventory_movement_lines', 'source_line_id', {
    notNull: true
  });

  pgm.addConstraint('inventory_movement_lines', NON_EMPTY_CHECK, {
    check: "btrim(source_line_id) <> ''"
  });

  pgm.dropIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    ifExists: true
  });

  pgm.createIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    unique: true
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    ifExists: true
  });

  pgm.createIndex('inventory_movement_lines', ['movement_id', 'source_line_id'], {
    name: IDENTITY_INDEX,
    unique: true,
    where: 'source_line_id IS NOT NULL'
  });

  pgm.dropConstraint('inventory_movement_lines', NON_EMPTY_CHECK, { ifExists: true });

  pgm.alterColumn('inventory_movement_lines', 'source_line_id', {
    notNull: false
  });
}
