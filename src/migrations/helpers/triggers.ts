import type { MigrationBuilder } from 'node-pg-migrate';

type EnsureTriggerOptions = {
  schema?: string;
  table: string;
  triggerName: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event: string;
  forEach?: 'ROW' | 'STATEMENT';
  functionSchema?: string;
  functionName: string;
};

function assertIdentifier(value: string, field: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`MIGRATION_IDENTIFIER_INVALID field=${field} value=${value}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeEvent(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!/^(INSERT|UPDATE|DELETE|TRUNCATE)( OR (INSERT|UPDATE|DELETE|TRUNCATE))*$/.test(normalized)) {
    throw new Error(`MIGRATION_TRIGGER_EVENT_INVALID value=${value}`);
  }
  return normalized;
}

/**
 * Ensures a trigger exists with the exact canonical definition PostgreSQL generates for the
 * requested timing/event/function binding. If a trigger with the same name exists but differs
 * in definition, raise loudly to prevent drift.
 */
export function ensureTriggerIfMissingOrFail(
  pgm: MigrationBuilder,
  options: EnsureTriggerOptions
): void {
  const schema = assertIdentifier(options.schema ?? 'public', 'schema');
  const table = assertIdentifier(options.table, 'table');
  const triggerName = assertIdentifier(options.triggerName, 'triggerName');
  const functionSchema = assertIdentifier(options.functionSchema ?? 'public', 'functionSchema');
  const functionName = assertIdentifier(options.functionName, 'functionName');
  const timing = options.timing;
  const event = normalizeEvent(options.event);
  const forEach = options.forEach ?? 'ROW';

  const probeTable = '__trigger_def_probe_table';
  const probeTrigger = '__trigger_def_probe_trigger';
  const targetRelation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

  pgm.sql(`
DO $$
DECLARE
  existing_def text;
  expected_def text;
  normalized_existing text;
  normalized_expected text;
BEGIN
  SELECT pg_get_triggerdef(t.oid, true)
    INTO existing_def
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
   WHERE n.nspname = ${quoteLiteral(schema)}
     AND c.relname = ${quoteLiteral(table)}
     AND t.tgname = ${quoteLiteral(triggerName)}
     AND NOT t.tgisinternal;

  CREATE TEMP TABLE IF NOT EXISTS ${quoteIdentifier(probeTable)} (
    LIKE ${targetRelation}
    INCLUDING DEFAULTS
    INCLUDING GENERATED
    INCLUDING IDENTITY
  ) ON COMMIT DROP;

  EXECUTE format(
    'DROP TRIGGER IF EXISTS %I ON %I.%I',
    ${quoteLiteral(probeTrigger)},
    (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()),
    ${quoteLiteral(probeTable)}
  );

  EXECUTE format(
    'CREATE TRIGGER %I %s %s ON %I.%I FOR EACH ${forEach} EXECUTE FUNCTION %I.%I()',
    ${quoteLiteral(probeTrigger)},
    ${quoteLiteral(timing)},
    ${quoteLiteral(event)},
    (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()),
    ${quoteLiteral(probeTable)},
    ${quoteLiteral(functionSchema)},
    ${quoteLiteral(functionName)}
  );

  SELECT pg_get_triggerdef(t.oid, true)
    INTO expected_def
    FROM pg_trigger t
    JOIN pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
   WHERE n.oid = pg_my_temp_schema()
     AND c.relname = ${quoteLiteral(probeTable)}
     AND t.tgname = ${quoteLiteral(probeTrigger)}
     AND NOT t.tgisinternal;

  IF expected_def IS NULL THEN
    RAISE EXCEPTION 'TRIGGER_PROBE_DEFINITION_MISSING trigger=% table=%.%',
      ${quoteLiteral(triggerName)},
      ${quoteLiteral(schema)},
      ${quoteLiteral(table)};
  END IF;

  IF existing_def IS NULL THEN
    EXECUTE format(
      'CREATE TRIGGER %I %s %s ON %I.%I FOR EACH ${forEach} EXECUTE FUNCTION %I.%I()',
      ${quoteLiteral(triggerName)},
      ${quoteLiteral(timing)},
      ${quoteLiteral(event)},
      ${quoteLiteral(schema)},
      ${quoteLiteral(table)},
      ${quoteLiteral(functionSchema)},
      ${quoteLiteral(functionName)}
    );
    RETURN;
  END IF;

  normalized_existing := regexp_replace(lower(existing_def), '\\s+', '', 'g');
  normalized_expected := regexp_replace(lower(expected_def), '\\s+', '', 'g');

  IF normalized_existing <> normalized_expected THEN
    RAISE EXCEPTION 'TRIGGER_DEFINITION_MISMATCH trigger=% table=%.% existing=% expected=%',
      ${quoteLiteral(triggerName)},
      ${quoteLiteral(schema)},
      ${quoteLiteral(table)},
      existing_def,
      expected_def;
  END IF;
END
$$;
  `);
}