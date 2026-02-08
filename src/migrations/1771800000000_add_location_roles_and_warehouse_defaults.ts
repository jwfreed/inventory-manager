import type { MigrationBuilder } from 'node-pg-migrate';

const LOCATION_ROLE_VALUES = "('SELLABLE','QA','HOLD','REJECT','SCRAP')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('locations', {
    role: { type: 'text' },
    is_sellable: { type: 'boolean', notNull: true, default: false }
  });

  pgm.addConstraint('locations', 'chk_locations_role', {
    check: `role IN ${LOCATION_ROLE_VALUES}`
  });
  pgm.addConstraint('locations', 'chk_locations_role_sellable', {
    check: "(role = 'SELLABLE') = is_sellable"
  });
  pgm.createIndex('locations', ['tenant_id', 'is_sellable'], {
    name: 'idx_locations_tenant_sellable'
  });

  pgm.createTable('config_issues', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    issue_type: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'uuid', notNull: true },
    details: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('config_issues', ['tenant_id', 'issue_type'], { name: 'idx_config_issues_tenant_type' });

  // Backfill roles using explicit type values only (one-time migration).
  pgm.sql(`
    UPDATE locations
       SET role = CASE
         WHEN type = 'warehouse' THEN NULL
         WHEN LOWER(type) IN ('qa','quarantine') THEN 'QA'
         WHEN LOWER(type) = 'hold' THEN 'HOLD'
         WHEN LOWER(type) IN ('reject','mrb') THEN 'REJECT'
         WHEN LOWER(type) = 'scrap' THEN 'SCRAP'
         ELSE 'SELLABLE'
       END
  `);

  pgm.sql(`
    UPDATE locations
       SET is_sellable = CASE
         WHEN type = 'warehouse' THEN false
         ELSE (role = 'SELLABLE')
       END
  `);

  // Record potential role misclassifications for manual review (no runtime heuristics).
  pgm.sql(`
    INSERT INTO config_issues (id, tenant_id, issue_type, entity_type, entity_id, details, created_at)
    SELECT gen_random_uuid(),
           tenant_id,
           'LOCATION_ROLE_REVIEW',
           'location',
           id,
           jsonb_build_object('code', code, 'name', name, 'type', type),
           now()
      FROM locations
     WHERE role = 'SELLABLE'
       AND (
         code ILIKE '%qa%'
         OR name ILIKE '%quality%'
         OR name ILIKE '%inspect%'
         OR code ILIKE '%hold%'
         OR name ILIKE '%hold%'
         OR code ILIKE '%reject%'
         OR name ILIKE '%reject%'
         OR code ILIKE '%scrap%'
         OR name ILIKE '%scrap%'
       )
  `);

  pgm.createTable('warehouse_default_location', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    warehouse_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' }
  });

  pgm.addConstraint('warehouse_default_location', 'chk_warehouse_default_role', {
    check: `role IN ${LOCATION_ROLE_VALUES}`
  });
  pgm.addConstraint('warehouse_default_location', 'pk_warehouse_default_location', {
    primaryKey: ['tenant_id', 'warehouse_id', 'role']
  });
  pgm.addConstraint('warehouse_default_location', 'uq_warehouse_default_location_unique', {
    unique: ['tenant_id', 'warehouse_id', 'location_id']
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION resolve_warehouse_for_location(tenant uuid, loc uuid)
    RETURNS uuid AS $$
      WITH RECURSIVE tree AS (
        SELECT id, tenant_id, parent_location_id, type
          FROM locations
         WHERE id = loc AND tenant_id = tenant
        UNION ALL
        SELECT l.id, l.tenant_id, l.parent_location_id, l.type
          FROM locations l
          JOIN tree t ON t.parent_location_id = l.id AND l.tenant_id = t.tenant_id
      )
      SELECT id FROM tree WHERE type = 'warehouse' LIMIT 1;
    $$ LANGUAGE sql STABLE;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_warehouse_default_location()
    RETURNS trigger AS $$
    DECLARE
      resolved uuid;
    BEGIN
      SELECT resolve_warehouse_for_location(NEW.tenant_id, NEW.location_id) INTO resolved;
      IF resolved IS NULL THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATION_INVALID';
      END IF;
      IF resolved <> NEW.warehouse_id THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATION_MISMATCH';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER trg_warehouse_default_location_validate
      BEFORE INSERT OR UPDATE ON warehouse_default_location
      FOR EACH ROW
      EXECUTE FUNCTION enforce_warehouse_default_location();
  `);

  // Populate defaults from existing role-tagged locations when possible.
  pgm.sql(`
    WITH RECURSIVE tree AS (
      SELECT id,
             tenant_id,
             id AS warehouse_id,
             parent_location_id,
             type,
             role,
             created_at
        FROM locations
       WHERE type = 'warehouse'
      UNION ALL
      SELECT l.id,
             l.tenant_id,
             t.warehouse_id,
             l.parent_location_id,
             l.type,
             l.role,
             l.created_at
        FROM locations l
        JOIN tree t ON l.parent_location_id = t.id AND l.tenant_id = t.tenant_id
    ),
    ranked AS (
      SELECT tenant_id,
             warehouse_id,
             role,
             id AS location_id,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, warehouse_id, role
               ORDER BY created_at ASC, id ASC
             ) AS rn
        FROM tree
       WHERE role IN ('SELLABLE','QA','HOLD','REJECT','SCRAP')
    )
    INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
    SELECT tenant_id, warehouse_id, role, location_id
      FROM ranked
     WHERE rn = 1
    ON CONFLICT DO NOTHING;
  `);

  // Create missing role locations under each warehouse (deterministic codes), then set defaults.
  pgm.sql(`
    WITH warehouses AS (
      SELECT id, tenant_id
        FROM locations
       WHERE type = 'warehouse'
    ),
    required_roles AS (
      SELECT * FROM (VALUES ('SELLABLE'),('QA'),('HOLD'),('REJECT'),('SCRAP')) AS r(role)
    ),
    missing_roles AS (
      SELECT w.id AS warehouse_id,
             w.tenant_id,
             r.role
        FROM warehouses w
        JOIN required_roles r ON true
        LEFT JOIN locations l
          ON l.tenant_id = w.tenant_id
         AND l.role = r.role
         AND l.parent_location_id = w.id
       WHERE l.id IS NULL
    )
    INSERT INTO locations (
      id,
      tenant_id,
      code,
      name,
      type,
      role,
      is_sellable,
      active,
      parent_location_id,
      created_at,
      updated_at
    )
    SELECT gen_random_uuid(),
           mr.tenant_id,
           mr.role || '-' || substring(mr.warehouse_id::text, 1, 8),
           mr.role || ' Default',
           CASE WHEN mr.role = 'SCRAP' THEN 'scrap' ELSE 'bin' END,
           mr.role,
           (mr.role = 'SELLABLE'),
           true,
           mr.warehouse_id,
           now(),
           now()
      FROM missing_roles mr
    ON CONFLICT (code) DO NOTHING;
  `);

  pgm.sql(`
    WITH RECURSIVE tree AS (
      SELECT id,
             tenant_id,
             id AS warehouse_id,
             parent_location_id,
             type,
             role,
             created_at
        FROM locations
       WHERE type = 'warehouse'
      UNION ALL
      SELECT l.id,
             l.tenant_id,
             t.warehouse_id,
             l.parent_location_id,
             l.type,
             l.role,
             l.created_at
        FROM locations l
        JOIN tree t ON l.parent_location_id = t.id AND l.tenant_id = t.tenant_id
    ),
    ranked AS (
      SELECT tenant_id,
             warehouse_id,
             role,
             id AS location_id,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, warehouse_id, role
               ORDER BY created_at ASC, id ASC
             ) AS rn
        FROM tree
       WHERE role IN ('SELLABLE','QA','HOLD','REJECT','SCRAP')
    )
    INSERT INTO warehouse_default_location (tenant_id, warehouse_id, role, location_id)
    SELECT tenant_id, warehouse_id, role, location_id
      FROM ranked
     WHERE rn = 1
    ON CONFLICT DO NOTHING;
  `);

  // Enforce defaults for each warehouse (hard requirement).
  pgm.sql(`
    DO $$
    DECLARE
      missing_count integer;
    BEGIN
      SELECT COUNT(*) INTO missing_count
        FROM locations w
       WHERE w.type = 'warehouse'
         AND EXISTS (
           SELECT 1
             FROM (VALUES ('SELLABLE'),('QA'),('HOLD'),('REJECT')) AS r(role)
            WHERE NOT EXISTS (
              SELECT 1
                FROM warehouse_default_location d
               WHERE d.tenant_id = w.tenant_id
                 AND d.warehouse_id = w.id
                 AND d.role = r.role
            )
         );
      IF missing_count > 0 THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATIONS_REQUIRED';
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_warehouse_default_location_validate ON warehouse_default_location;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_warehouse_default_location();');
  pgm.sql('DROP FUNCTION IF EXISTS resolve_warehouse_for_location(uuid, uuid);');
  pgm.dropTable('warehouse_default_location');
  pgm.dropTable('config_issues');
  pgm.dropIndex('locations', 'idx_locations_tenant_sellable', { ifExists: true });
  pgm.dropConstraint('locations', 'chk_locations_role_sellable', { ifExists: true });
  pgm.dropConstraint('locations', 'chk_locations_role', { ifExists: true });
  pgm.dropColumns('locations', ['role', 'is_sellable']);
}
