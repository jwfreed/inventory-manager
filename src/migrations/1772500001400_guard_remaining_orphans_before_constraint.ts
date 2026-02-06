import type { MigrationBuilder } from 'node-pg-migrate';

const AUDIT_TABLE = 'migration_orphan_parent_fix_1772500001300';

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
      r record;
      v_query text;
    BEGIN
      FOR r IN
        WITH orphan_tenants AS (
          SELECT tenant_id, COUNT(*) AS orphan_count
            FROM locations
           WHERE parent_location_id IS NULL
             AND type <> 'warehouse'
           GROUP BY tenant_id
        ),
        wh_counts AS (
          SELECT tenant_id, COUNT(*) AS warehouse_count
            FROM locations
           WHERE type = 'warehouse'
           GROUP BY tenant_id
        )
        SELECT o.tenant_id,
               o.orphan_count,
               COALESCE(w.warehouse_count, 0) AS warehouse_count
          FROM orphan_tenants o
          LEFT JOIN wh_counts w USING (tenant_id)
         ORDER BY o.orphan_count DESC, o.tenant_id
      LOOP
        IF r.warehouse_count = 0 THEN
          RAISE EXCEPTION 'NO_WAREHOUSE_ROOT tenant_id=% orphan_count=%', r.tenant_id, r.orphan_count;
        ELSIF r.warehouse_count > 1 THEN
          v_query := format(
            'SELECT id, code, name FROM locations WHERE tenant_id = %L AND type = ''warehouse'' ORDER BY code, name, id::text;',
            r.tenant_id
          );
          RAISE EXCEPTION 'MULTI_WAREHOUSE_MAPPING_REQUIRED tenant_id=% orphan_count=% warehouse_count=% query=%',
            r.tenant_id, r.orphan_count, r.warehouse_count, v_query;
        END IF;
      END LOOP;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(AUDIT_TABLE);
}
