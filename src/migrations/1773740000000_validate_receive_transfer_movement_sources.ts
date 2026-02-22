import type { MigrationBuilder } from 'node-pg-migrate';

const CONSTRAINT_NAME = 'chk_inventory_movements_receive_transfer_source_required';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      v_remaining_count integer;
      v_posted_remaining_count integer;
      v_sample jsonb;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = '${CONSTRAINT_NAME}'
      ) THEN
        RAISE EXCEPTION 'MISSING_CONSTRAINT_%', '${CONSTRAINT_NAME}';
      END IF;

      -- Deterministic legacy cleanup for mutable rows only.
      UPDATE inventory_movements
         SET source_type = split_part(external_ref, ':', 1),
             source_id = substring(external_ref from position(':' in external_ref) + 1)
       WHERE movement_type IN ('receive', 'transfer')
         AND status <> 'posted'
         AND (
           source_type IS NULL OR BTRIM(source_type) = ''
           OR source_id IS NULL OR BTRIM(source_id) = ''
         )
         AND external_ref IS NOT NULL
         AND position(':' in external_ref) > 0;

      SELECT COUNT(*)::int
        INTO v_posted_remaining_count
        FROM inventory_movements
       WHERE movement_type IN ('receive', 'transfer')
         AND status = 'posted'
         AND (
           source_type IS NULL OR BTRIM(source_type) = ''
           OR source_id IS NULL OR BTRIM(source_id) = ''
         );

      IF v_posted_remaining_count > 0 THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
          INTO v_sample
          FROM (
            SELECT id, tenant_id, movement_type, status, external_ref, occurred_at
              FROM inventory_movements
             WHERE movement_type IN ('receive', 'transfer')
               AND status = 'posted'
               AND (
                 source_type IS NULL OR BTRIM(source_type) = ''
                 OR source_id IS NULL OR BTRIM(source_id) = ''
               )
             ORDER BY occurred_at ASC NULLS LAST, id ASC
             LIMIT 20
          ) s;

        RAISE EXCEPTION USING
          MESSAGE = 'MOVEMENT_SOURCE_BACKFILL_REQUIRES_AUDIT',
          DETAIL = jsonb_build_object(
            'constraint', '${CONSTRAINT_NAME}',
            'postedInvalidCount', v_posted_remaining_count,
            'sample', v_sample
          )::text,
          HINT = 'Reset dev DB with CONFIRM_DB_RESET=1 npm run db:reset:migrate:seed or repair posted movement source metadata via audited SQL.';
      END IF;

      SELECT COUNT(*)::int
        INTO v_remaining_count
        FROM inventory_movements
       WHERE movement_type IN ('receive', 'transfer')
         AND (
           source_type IS NULL OR BTRIM(source_type) = ''
           OR source_id IS NULL OR BTRIM(source_id) = ''
         );

      IF v_remaining_count > 0 THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
          INTO v_sample
          FROM (
            SELECT id, tenant_id, movement_type, status, external_ref, occurred_at
              FROM inventory_movements
             WHERE movement_type IN ('receive', 'transfer')
               AND (
                 source_type IS NULL OR BTRIM(source_type) = ''
                 OR source_id IS NULL OR BTRIM(source_id) = ''
               )
             ORDER BY occurred_at ASC NULLS LAST, id ASC
             LIMIT 20
          ) s;

        RAISE EXCEPTION USING
          MESSAGE = 'MOVEMENT_SOURCE_BACKFILL_INCOMPLETE',
          DETAIL = jsonb_build_object(
            'constraint', '${CONSTRAINT_NAME}',
            'remainingCount', v_remaining_count,
            'sample', v_sample
          )::text;
      END IF;

      ALTER TABLE inventory_movements
        VALIDATE CONSTRAINT ${CONSTRAINT_NAME};
    END
    $$;
  `);
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // Validation is irreversible without dropping and recreating the constraint.
}
