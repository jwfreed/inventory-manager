import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Follow-on hardening after tenant-scoping rollout:
 * - fail fast if tenant_id is missing
 * - enforce routing_steps tenant consistency against routings/work_centers
 * - keep per-tenant code uniqueness for production areas
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM work_centers WHERE tenant_id IS NULL) THEN
        RAISE EXCEPTION 'WORK_CENTERS_TENANT_ID_NULL';
      END IF;
      IF EXISTS (SELECT 1 FROM routings WHERE tenant_id IS NULL) THEN
        RAISE EXCEPTION 'ROUTINGS_TENANT_ID_NULL';
      END IF;
      IF EXISTS (SELECT 1 FROM routing_steps WHERE tenant_id IS NULL) THEN
        RAISE EXCEPTION 'ROUTING_STEPS_TENANT_ID_NULL';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM routing_steps rs
          JOIN routings r
            ON r.id = rs.routing_id
         WHERE rs.tenant_id <> r.tenant_id
      ) THEN
        RAISE EXCEPTION 'ROUTING_STEPS_ROUTING_TENANT_MISMATCH';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM routing_steps rs
          JOIN work_centers wc
            ON wc.id = rs.work_center_id
         WHERE rs.tenant_id <> wc.tenant_id
      ) THEN
        RAISE EXCEPTION 'ROUTING_STEPS_WORK_CENTER_TENANT_MISMATCH';
      END IF;
    END $$;
  `);

  pgm.sql(`
    -- Re-assert existing tenant non-null invariant (already introduced in prior tenant-scoping migration).
    -- No down() reversal is required because this migration is hardening, not introducing new nullability semantics.
    ALTER TABLE work_centers ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE routings ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE routing_steps ALTER COLUMN tenant_id SET NOT NULL;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'work_centers_code_key'
           AND conrelid = 'work_centers'::regclass
      ) THEN
        ALTER TABLE work_centers DROP CONSTRAINT work_centers_code_key;
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_centers_tenant_id_id_unique
      ON work_centers (tenant_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routings_tenant_id_id_unique
      ON routings (tenant_id, id);
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_routing_steps_routing_tenant'
           AND conrelid = 'routing_steps'::regclass
      ) THEN
        ALTER TABLE routing_steps
          ADD CONSTRAINT fk_routing_steps_routing_tenant
          FOREIGN KEY (tenant_id, routing_id)
          REFERENCES routings(tenant_id, id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_routing_steps_work_center_tenant'
           AND conrelid = 'routing_steps'::regclass
      ) THEN
        ALTER TABLE routing_steps
          ADD CONSTRAINT fk_routing_steps_work_center_tenant
          FOREIGN KEY (tenant_id, work_center_id)
          REFERENCES work_centers(tenant_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE routing_steps DROP CONSTRAINT IF EXISTS fk_routing_steps_work_center_tenant;
    ALTER TABLE routing_steps DROP CONSTRAINT IF EXISTS fk_routing_steps_routing_tenant;
  `);

  pgm.sql(`
    DROP INDEX IF EXISTS idx_routings_tenant_id_id_unique;
    DROP INDEX IF EXISTS idx_work_centers_tenant_id_id_unique;
  `);
}
