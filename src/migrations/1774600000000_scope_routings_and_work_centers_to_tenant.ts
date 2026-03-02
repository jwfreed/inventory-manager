import type { MigrationBuilder } from 'node-pg-migrate';

const FALLBACK_TENANT_SQL = `(SELECT id FROM tenants ORDER BY created_at ASC, id ASC LIMIT 1)`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM tenants) THEN
        RAISE EXCEPTION 'TENANT_BACKFILL_SOURCE_MISSING';
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE work_centers ADD COLUMN IF NOT EXISTS tenant_id uuid;
    ALTER TABLE routings ADD COLUMN IF NOT EXISTS tenant_id uuid;
    ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS tenant_id uuid;
  `);

  pgm.sql(`
    UPDATE work_centers wc
       SET tenant_id = l.tenant_id
      FROM locations l
     WHERE wc.tenant_id IS NULL
       AND wc.location_id IS NOT NULL
       AND l.id = wc.location_id;
  `);
  pgm.sql(`
    UPDATE work_centers
       SET tenant_id = ${FALLBACK_TENANT_SQL}
     WHERE tenant_id IS NULL;
  `);

  pgm.sql(`
    UPDATE routings r
       SET tenant_id = i.tenant_id
      FROM items i
     WHERE r.tenant_id IS NULL
       AND i.id = r.item_id;
  `);
  pgm.sql(`
    UPDATE routings
       SET tenant_id = ${FALLBACK_TENANT_SQL}
     WHERE tenant_id IS NULL;
  `);

  pgm.sql(`
    UPDATE routing_steps rs
       SET tenant_id = r.tenant_id
      FROM routings r
     WHERE rs.tenant_id IS NULL
       AND r.id = rs.routing_id;
  `);
  pgm.sql(`
    UPDATE routing_steps rs
       SET tenant_id = wc.tenant_id
      FROM work_centers wc
     WHERE rs.tenant_id IS NULL
       AND wc.id = rs.work_center_id;
  `);
  pgm.sql(`
    UPDATE routing_steps
       SET tenant_id = ${FALLBACK_TENANT_SQL}
     WHERE tenant_id IS NULL;
  `);

  pgm.sql(`
    ALTER TABLE work_centers ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE routings ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE routing_steps ALTER COLUMN tenant_id SET NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE work_centers
      ADD CONSTRAINT fk_work_centers_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    ALTER TABLE routings
      ADD CONSTRAINT fk_routings_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    ALTER TABLE routing_steps
      ADD CONSTRAINT fk_routing_steps_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_centers_tenant_code_unique
      ON work_centers (tenant_id, code);
    CREATE INDEX IF NOT EXISTS idx_work_centers_tenant
      ON work_centers (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_routings_tenant
      ON routings (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_routings_tenant_item
      ON routings (tenant_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_routing_steps_tenant
      ON routing_steps (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_routing_steps_tenant_routing
      ON routing_steps (tenant_id, routing_id);
    CREATE INDEX IF NOT EXISTS idx_routing_steps_tenant_work_center
      ON routing_steps (tenant_id, work_center_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_routing_steps_tenant_work_center;
    DROP INDEX IF EXISTS idx_routing_steps_tenant_routing;
    DROP INDEX IF EXISTS idx_routing_steps_tenant;
    DROP INDEX IF EXISTS idx_routings_tenant_item;
    DROP INDEX IF EXISTS idx_routings_tenant;
    DROP INDEX IF EXISTS idx_work_centers_tenant;
    DROP INDEX IF EXISTS idx_work_centers_tenant_code_unique;
  `);

  pgm.sql(`
    ALTER TABLE routing_steps DROP CONSTRAINT IF EXISTS fk_routing_steps_tenant;
    ALTER TABLE routings DROP CONSTRAINT IF EXISTS fk_routings_tenant;
    ALTER TABLE work_centers DROP CONSTRAINT IF EXISTS fk_work_centers_tenant;
  `);

  pgm.sql(`
    ALTER TABLE routing_steps DROP COLUMN IF EXISTS tenant_id;
    ALTER TABLE routings DROP COLUMN IF EXISTS tenant_id;
    ALTER TABLE work_centers DROP COLUMN IF EXISTS tenant_id;
  `);

  pgm.sql(`
    ALTER TABLE work_centers
      ADD CONSTRAINT work_centers_code_key UNIQUE (code);
  `);
}
