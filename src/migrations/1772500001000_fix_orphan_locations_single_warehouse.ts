import type { MigrationBuilder } from 'node-pg-migrate';

const AUDIT_TABLE = 'migration_orphan_parent_fix_1772500001000';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(AUDIT_TABLE, {
    location_id: { type: 'uuid', primaryKey: true, notNull: true, references: 'locations', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    warehouse_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.sql(`
    DO $$
    DECLARE
      v_before integer;
      v_after integer;
      v_updated integer;
      v_tenants integer;
      r record;
    BEGIN
      SELECT COUNT(*) INTO v_before
        FROM locations
       WHERE parent_location_id IS NULL
         AND type <> 'warehouse';

      WITH single_wh AS (
        SELECT tenant_id, MIN(id::text)::uuid AS warehouse_id
          FROM locations
         WHERE type = 'warehouse'
         GROUP BY tenant_id
        HAVING COUNT(*) = 1
      ),
      updated AS (
        UPDATE locations l
           SET parent_location_id = sw.warehouse_id
          FROM single_wh sw
         WHERE l.tenant_id = sw.tenant_id
           AND l.parent_location_id IS NULL
           AND l.type <> 'warehouse'
        RETURNING l.id, l.tenant_id, sw.warehouse_id
      ),
      inserted AS (
        INSERT INTO ${AUDIT_TABLE} (location_id, tenant_id, warehouse_id)
        SELECT id, tenant_id, warehouse_id FROM updated
        ON CONFLICT (location_id) DO NOTHING
        RETURNING tenant_id
      )
      SELECT COUNT(*), COUNT(DISTINCT tenant_id)
        INTO v_updated, v_tenants
        FROM inserted;

      SELECT COUNT(*) INTO v_after
        FROM locations
       WHERE parent_location_id IS NULL
         AND type <> 'warehouse';

      RAISE NOTICE 'orphan_fix: before=%, updated=%, remaining=%, tenants=%',
        v_before, v_updated, v_after, v_tenants;

      FOR r IN
        SELECT tenant_id, COUNT(*) AS remaining_orphans
          FROM locations
         WHERE parent_location_id IS NULL
           AND type <> 'warehouse'
         GROUP BY tenant_id
         ORDER BY remaining_orphans DESC
      LOOP
        RAISE NOTICE 'orphan_fix_remaining: tenant_id=% count=%', r.tenant_id, r.remaining_orphans;
      END LOOP;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE locations
       SET parent_location_id = NULL
     WHERE id IN (SELECT location_id FROM ${AUDIT_TABLE});
  `);
  pgm.dropTable(AUDIT_TABLE);
}
