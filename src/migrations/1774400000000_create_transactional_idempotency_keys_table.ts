import type { MigrationBuilder } from 'node-pg-migrate';

const LEGACY_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      tenant_id uuid,
      key text NOT NULL,
      endpoint text,
      request_hash text,
      response_status integer,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      status text,
      response_ref text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    ALTER TABLE idempotency_keys
      ADD COLUMN IF NOT EXISTS tenant_id uuid,
      ADD COLUMN IF NOT EXISTS endpoint text,
      ADD COLUMN IF NOT EXISTS request_hash text,
      ADD COLUMN IF NOT EXISTS response_status integer,
      ADD COLUMN IF NOT EXISTS response_body jsonb,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS status text,
      ADD COLUMN IF NOT EXISTS response_ref text,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `);

  pgm.sql(`
    UPDATE idempotency_keys
       SET tenant_id = '${LEGACY_TENANT_ID}'::uuid
     WHERE tenant_id IS NULL;

    UPDATE idempotency_keys
       SET endpoint = '__legacy__'
     WHERE endpoint IS NULL
        OR btrim(endpoint) = '';

    UPDATE idempotency_keys
       SET request_hash = md5(key)
     WHERE request_hash IS NULL
        OR btrim(request_hash) = '';

    UPDATE idempotency_keys
       SET response_status = CASE
           WHEN status = 'SUCCEEDED' THEN 200
           WHEN status = 'FAILED' THEN 500
           ELSE -1
         END
     WHERE response_status IS NULL;

    UPDATE idempotency_keys
       SET response_body = '{}'::jsonb
     WHERE response_body IS NULL;
  `);

  pgm.sql(`
    DO $$
    DECLARE
      existing_pk_name text;
      existing_pk_def text;
      normalized_pk text;
    BEGIN
      SELECT c.conname, pg_get_constraintdef(c.oid)
        INTO existing_pk_name, existing_pk_def
        FROM pg_constraint c
       WHERE c.conrelid = 'idempotency_keys'::regclass
         AND c.contype = 'p';

      IF existing_pk_name IS NULL THEN
        ALTER TABLE idempotency_keys
          ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key);
      ELSE
        normalized_pk := regexp_replace(lower(existing_pk_def), '\\s+', '', 'g');
        IF normalized_pk = 'primarykey(key)' THEN
          EXECUTE format('ALTER TABLE idempotency_keys DROP CONSTRAINT %I', existing_pk_name);
          ALTER TABLE idempotency_keys
            ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key);
        ELSIF normalized_pk <> 'primarykey(tenant_id,key)' THEN
          RAISE EXCEPTION 'IDEMPOTENCY_KEYS_PRIMARY_KEY_MISMATCH existing=% expected one of=%',
            existing_pk_def,
            ARRAY['PRIMARY KEY (key)', 'PRIMARY KEY (tenant_id, key)'];
        END IF;
      END IF;
    END
    $$;
  `);

  pgm.sql(`
    ALTER TABLE idempotency_keys
      ALTER COLUMN tenant_id SET NOT NULL,
      ALTER COLUMN tenant_id SET DEFAULT '${LEGACY_TENANT_ID}'::uuid,
      ALTER COLUMN endpoint SET NOT NULL,
      ALTER COLUMN endpoint SET DEFAULT '__legacy__',
      ALTER COLUMN request_hash SET NOT NULL,
      ALTER COLUMN response_status SET NOT NULL,
      ALTER COLUMN response_status SET DEFAULT -1,
      ALTER COLUMN response_body SET NOT NULL,
      ALTER COLUMN response_body SET DEFAULT '{}'::jsonb,
      ALTER COLUMN status SET DEFAULT 'IN_PROGRESS',
      ALTER COLUMN updated_at SET DEFAULT now(),
      ALTER COLUMN created_at SET NOT NULL;
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
      ON idempotency_keys (created_at);
  `);

  pgm.sql(`
    DO $$
    DECLARE
      tenant_type text;
      key_type text;
      endpoint_type text;
      request_hash_type text;
      response_status_type text;
      response_body_type text;
      created_at_type text;
      pk_def text;
      normalized_pk text;
    BEGIN
      SELECT data_type INTO tenant_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'tenant_id';
      SELECT data_type INTO key_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'key';
      SELECT data_type INTO endpoint_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'endpoint';
      SELECT data_type INTO request_hash_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'request_hash';
      SELECT data_type INTO response_status_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'response_status';
      SELECT data_type INTO response_body_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'response_body';
      SELECT data_type INTO created_at_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'idempotency_keys'
         AND column_name = 'created_at';

      IF tenant_type <> 'uuid'
         OR key_type <> 'text'
         OR endpoint_type <> 'text'
         OR request_hash_type <> 'text'
         OR response_status_type <> 'integer'
         OR response_body_type <> 'jsonb'
         OR created_at_type <> 'timestamp with time zone' THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEYS_TABLE_DEFINITION_MISMATCH types=%',
          json_build_object(
            'tenant_id', tenant_type,
            'key', key_type,
            'endpoint', endpoint_type,
            'request_hash', request_hash_type,
            'response_status', response_status_type,
            'response_body', response_body_type,
            'created_at', created_at_type
          );
      END IF;

      SELECT pg_get_constraintdef(c.oid)
        INTO pk_def
        FROM pg_constraint c
       WHERE c.conrelid = 'idempotency_keys'::regclass
         AND c.contype = 'p';

      IF pk_def IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEYS_PRIMARY_KEY_MISSING';
      END IF;

      normalized_pk := regexp_replace(lower(pk_def), '\\s+', '', 'g');
      IF normalized_pk <> 'primarykey(tenant_id,key)' THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEYS_PRIMARY_KEY_MISMATCH existing=% expected=%',
          pk_def,
          'PRIMARY KEY (tenant_id, key)';
      END IF;
    END
    $$;
  `);
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // No-op by design. This hardening migration rewrites idempotency schema and should not rollback.
}
