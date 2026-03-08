import type { MigrationBuilder } from 'node-pg-migrate';

function hasColumnSql(tableName: string, columnName: string) {
  return `EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = '${tableName}'
       AND column_name = '${columnName}'
  )`;
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF ${hasColumnSql('work_orders', 'routing_id')}
         AND ${hasColumnSql('work_orders', 'tenant_id')}
         AND ${hasColumnSql('work_orders', 'output_item_id')}
         AND ${hasColumnSql('work_orders', 'kind')}
         AND ${hasColumnSql('work_orders', 'status')}
      THEN
        UPDATE work_orders wo
           SET routing_id = (
             SELECT r.id
               FROM routings r
              WHERE r.tenant_id = wo.tenant_id
                AND r.item_id = wo.output_item_id
              ORDER BY
                CASE WHEN r.is_default THEN 0 ELSE 1 END,
                CASE
                  WHEN r.status = 'active' THEN 0
                  WHEN r.status = 'draft' THEN 1
                  ELSE 2
                END,
                r.updated_at DESC,
                r.created_at DESC,
                r.id
              LIMIT 1
           )
         WHERE wo.routing_id IS NULL
           AND wo.kind = 'production'
           AND wo.status IN ('draft', 'released', 'in_progress')
           AND EXISTS (
             SELECT 1
               FROM routings r
              WHERE r.tenant_id = wo.tenant_id
                AND r.item_id = wo.output_item_id
           );
      END IF;
    END $$;
  `);
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // irreversible data backfill
}
