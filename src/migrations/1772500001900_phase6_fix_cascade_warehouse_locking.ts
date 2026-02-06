import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION cascade_warehouse_id_to_descendants(
      p_tenant_id UUID,
      p_location_id UUID,
      p_new_warehouse_id UUID
    ) RETURNS VOID AS $$
    DECLARE
      v_count integer;
      v_ids uuid[];
    BEGIN
      WITH RECURSIVE descendants AS (
        SELECT id, parent_location_id, tenant_id, 1 AS depth
          FROM locations
         WHERE tenant_id = p_tenant_id
           AND parent_location_id = p_location_id
        UNION ALL
        SELECT l.id, l.parent_location_id, l.tenant_id, d.depth + 1 AS depth
          FROM locations l
          JOIN descendants d
            ON l.parent_location_id = d.id
           AND l.tenant_id = d.tenant_id
         WHERE d.depth < 1000
      )
      SELECT COUNT(*) INTO v_count FROM descendants;

      IF v_count = 0 THEN
        RETURN;
      END IF;

      IF v_count > 1000 THEN
        RAISE EXCEPTION 'CASCADE_SIZE_EXCEEDED'
          USING DETAIL = format('descendant_count=%s', v_count);
      END IF;

      WITH RECURSIVE descendants AS (
        SELECT id, parent_location_id, tenant_id, 1 AS depth
          FROM locations
         WHERE tenant_id = p_tenant_id
           AND parent_location_id = p_location_id
        UNION ALL
        SELECT l.id, l.parent_location_id, l.tenant_id, d.depth + 1 AS depth
          FROM locations l
          JOIN descendants d
            ON l.parent_location_id = d.id
           AND l.tenant_id = d.tenant_id
         WHERE d.depth < 1000
      )
      SELECT array_agg(id) INTO v_ids FROM descendants;

      BEGIN
        PERFORM 1
          FROM locations
         WHERE tenant_id = p_tenant_id
           AND id = ANY(v_ids)
         FOR UPDATE NOWAIT;
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE EXCEPTION 'CASCADE_LOCK_CONFLICT';
      END;

      UPDATE locations
         SET warehouse_id = p_new_warehouse_id
       WHERE tenant_id = p_tenant_id
         AND id = ANY(v_ids);
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP FUNCTION IF EXISTS cascade_warehouse_id_to_descendants(UUID, UUID, UUID);
  `);
}

