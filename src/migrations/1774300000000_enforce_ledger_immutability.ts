import type { MigrationBuilder } from 'node-pg-migrate';
import { ensureTriggerIfMissingOrFail } from './helpers/triggers';

/*
-- ledger-immutability:allow-dangerous-migration
-- reason: Down migration intentionally drops ledger immutability triggers/function for explicit rollback support. #177430
*/

const LEDGER_MUTATION_FUNCTION = 'prevent_ledger_mutation';
const LEDGER_MUTATION_FUNCTION_BODY = `
BEGIN
  RAISE EXCEPTION 'Ledger tables are append-only. UPDATE/DELETE is not allowed on %', TG_TABLE_NAME;
END;
`;

function ensureLedgerMutationFunctionIfMissingOrFail(pgm: MigrationBuilder): void {
  const expectedBodyLiteral = `'${LEDGER_MUTATION_FUNCTION_BODY.replace(/'/g, "''")}'`;

  pgm.sql(`
DO $$
DECLARE
  existing_body text;
  expected_body text := ${expectedBodyLiteral};
  normalized_existing text;
  normalized_expected text;
BEGIN
  SELECT p.prosrc
    INTO existing_body
    FROM pg_proc p
    JOIN pg_namespace n
      ON n.oid = p.pronamespace
    JOIN pg_language l
      ON l.oid = p.prolang
    JOIN pg_type t
      ON t.oid = p.prorettype
   WHERE n.nspname = 'public'
     AND p.proname = '${LEDGER_MUTATION_FUNCTION}'
     AND p.pronargs = 0
     AND l.lanname = 'plpgsql'
     AND t.typname = 'trigger';

  IF existing_body IS NULL THEN
    CREATE FUNCTION public.${LEDGER_MUTATION_FUNCTION}()
    RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'Ledger tables are append-only. UPDATE/DELETE is not allowed on %', TG_TABLE_NAME;
    END;
    $fn$ LANGUAGE plpgsql;
    RETURN;
  END IF;

  normalized_existing := regexp_replace(lower(existing_body), '\\s+', '', 'g');
  normalized_expected := regexp_replace(lower(expected_body), '\\s+', '', 'g');

  IF normalized_existing <> normalized_expected THEN
    RAISE EXCEPTION 'FUNCTION_DEFINITION_MISMATCH function=% existing=% expected=%',
      '${LEDGER_MUTATION_FUNCTION}',
      existing_body,
      expected_body;
  END IF;
END
$$;
  `);
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  ensureLedgerMutationFunctionIfMissingOrFail(pgm);

  ensureTriggerIfMissingOrFail(pgm, {
    table: 'inventory_movements',
    triggerName: 'inventory_movements_no_update',
    timing: 'BEFORE',
    event: 'UPDATE',
    functionName: LEDGER_MUTATION_FUNCTION
  });

  ensureTriggerIfMissingOrFail(pgm, {
    table: 'inventory_movements',
    triggerName: 'inventory_movements_no_delete',
    timing: 'BEFORE',
    event: 'DELETE',
    functionName: LEDGER_MUTATION_FUNCTION
  });

  ensureTriggerIfMissingOrFail(pgm, {
    table: 'inventory_movement_lines',
    triggerName: 'inventory_movement_lines_no_update',
    timing: 'BEFORE',
    event: 'UPDATE',
    functionName: LEDGER_MUTATION_FUNCTION
  });

  ensureTriggerIfMissingOrFail(pgm, {
    table: 'inventory_movement_lines',
    triggerName: 'inventory_movement_lines_no_delete',
    timing: 'BEFORE',
    event: 'DELETE',
    functionName: LEDGER_MUTATION_FUNCTION
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS inventory_movement_lines_no_delete ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS inventory_movement_lines_no_update ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS inventory_movements_no_delete ON inventory_movements;');
  pgm.sql('DROP TRIGGER IF EXISTS inventory_movements_no_update ON inventory_movements;');
  pgm.sql('DROP FUNCTION IF EXISTS public.prevent_ledger_mutation();');
}
