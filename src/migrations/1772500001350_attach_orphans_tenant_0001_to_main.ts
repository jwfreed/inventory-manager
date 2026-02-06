import type { MigrationBuilder } from 'node-pg-migrate';

const AUDIT_TABLE = 'migration_orphan_parent_fix_1772500001350';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TARGET_WAREHOUSE_ID = '1479eae2-0b3b-407b-9450-648e0dcb3e18';

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
    BEGIN
      SELECT COUNT(*) INTO v_before
        FROM locations
       WHERE tenant_id = '${TENANT_ID}'
         AND parent_location_id IS NULL
         AND type <> 'warehouse';

      WITH updated AS (
        UPDATE locations
           SET parent_location_id = '${TARGET_WAREHOUSE_ID}'
         WHERE tenant_id = '${TENANT_ID}'
           AND parent_location_id IS NULL
           AND type <> 'warehouse'
         RETURNING id, tenant_id
      ),
      inserted AS (
        INSERT INTO ${AUDIT_TABLE} (location_id, tenant_id, warehouse_id)
        SELECT id, tenant_id, '${TARGET_WAREHOUSE_ID}'::uuid FROM updated
        ON CONFLICT (location_id) DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_updated FROM inserted;

      SELECT COUNT(*) INTO v_after
        FROM locations
       WHERE tenant_id = '${TENANT_ID}'
         AND parent_location_id IS NULL
         AND type <> 'warehouse';

      RAISE NOTICE 'orphan_fix_tenant_0001: before=%, updated=%, after=%',
        v_before, v_updated, v_after;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE locations l
       SET parent_location_id = NULL
      FROM ${AUDIT_TABLE} a
     WHERE l.id = a.location_id
       AND l.tenant_id = a.tenant_id
       AND l.parent_location_id = a.warehouse_id;
  `);
  pgm.dropTable(AUDIT_TABLE);
}
