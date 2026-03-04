import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE item_uom_overrides
      ADD COLUMN IF NOT EXISTS source text;

    UPDATE item_uom_overrides
       SET source = 'manual'
     WHERE source IS NULL;

    ALTER TABLE item_uom_overrides
      ALTER COLUMN source SET DEFAULT 'manual';

    ALTER TABLE item_uom_overrides
      ALTER COLUMN source SET NOT NULL;

    ALTER TABLE item_uom_overrides
      DROP CONSTRAINT IF EXISTS chk_item_uom_overrides_source;

    ALTER TABLE item_uom_overrides
      ADD CONSTRAINT chk_item_uom_overrides_source
      CHECK (source IN ('manual', 'legacy_backfill', 'api'));
  `);

  pgm.sql(`
    DELETE FROM uom_aliases ua
     WHERE EXISTS (
       SELECT 1
         FROM uoms u
        WHERE LOWER(u.code) = LOWER(ua.alias_code)
     );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_uoms_code_lower_unique
      ON uoms (LOWER(code));

    CREATE UNIQUE INDEX IF NOT EXISTS idx_uom_aliases_alias_code_lower_unique
      ON uom_aliases (LOWER(alias_code));

    CREATE OR REPLACE FUNCTION prevent_uom_alias_canonical_collision()
    RETURNS trigger AS $$
    DECLARE
      v_collision text;
    BEGIN
      SELECT code INTO v_collision
        FROM uoms
       WHERE LOWER(code) = LOWER(NEW.alias_code)
       LIMIT 1;

      IF v_collision IS NOT NULL THEN
        RAISE EXCEPTION 'UOM_ALIAS_CANONICAL_COLLISION:%', NEW.alias_code;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_uom_aliases_prevent_collision ON uom_aliases;
    CREATE TRIGGER trg_uom_aliases_prevent_collision
      BEFORE INSERT OR UPDATE ON uom_aliases
      FOR EACH ROW
      EXECUTE FUNCTION prevent_uom_alias_canonical_collision();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_item_uom_override_dimension()
    RETURNS trigger AS $$
    DECLARE
      v_from_dimension text;
      v_to_dimension text;
    BEGIN
      SELECT u.dimension INTO v_from_dimension
        FROM uoms u
       WHERE LOWER(u.code) = LOWER(NEW.from_uom)
       LIMIT 1;

      IF v_from_dimension IS NULL THEN
        SELECT uc.dimension INTO v_from_dimension
          FROM uom_aliases a
          JOIN uoms uc ON uc.code = a.canonical_code
         WHERE LOWER(a.alias_code) = LOWER(NEW.from_uom)
         LIMIT 1;
      END IF;

      SELECT u.dimension INTO v_to_dimension
        FROM uoms u
       WHERE LOWER(u.code) = LOWER(NEW.to_uom)
       LIMIT 1;

      IF v_to_dimension IS NULL THEN
        SELECT uc.dimension INTO v_to_dimension
          FROM uom_aliases a
          JOIN uoms uc ON uc.code = a.canonical_code
         WHERE LOWER(a.alias_code) = LOWER(NEW.to_uom)
         LIMIT 1;
      END IF;

      IF v_from_dimension IS NOT NULL
         AND v_to_dimension IS NOT NULL
         AND v_from_dimension <> v_to_dimension THEN
        RAISE EXCEPTION 'UOM_DIMENSION_MISMATCH:%->%', NEW.from_uom, NEW.to_uom;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_item_uom_overrides_dimension_guard ON item_uom_overrides;
    CREATE TRIGGER trg_item_uom_overrides_dimension_guard
      BEFORE INSERT OR UPDATE ON item_uom_overrides
      FOR EACH ROW
      EXECUTE FUNCTION enforce_item_uom_override_dimension();
  `);

  pgm.sql(`
    WITH legacy_source AS (
      SELECT tenant_id,
             item_id,
             LOWER(from_uom) AS from_uom,
             LOWER(to_uom) AS to_uom,
             factor
        FROM uom_conversions
       WHERE factor > 0
         AND trim(from_uom) <> ''
         AND trim(to_uom) <> ''
    )
    UPDATE item_uom_overrides o
       SET source = 'legacy_backfill',
           updated_at = now()
      FROM legacy_source s
     WHERE o.tenant_id = s.tenant_id
       AND o.item_id = s.item_id
       AND LOWER(o.from_uom) = s.from_uom
       AND LOWER(o.to_uom) = s.to_uom
       AND o.active = true
       AND o.source = 'manual';

    WITH legacy_source AS (
      SELECT tenant_id,
             item_id,
             LOWER(from_uom) AS from_uom,
             LOWER(to_uom) AS to_uom,
             factor
        FROM uom_conversions
       WHERE factor > 0
         AND trim(from_uom) <> ''
         AND trim(to_uom) <> ''
    )
    INSERT INTO item_uom_overrides (
      id,
      tenant_id,
      item_id,
      from_uom,
      to_uom,
      multiplier,
      active,
      source,
      created_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      s.tenant_id,
      s.item_id,
      s.from_uom,
      s.to_uom,
      s.factor,
      true,
      'legacy_backfill',
      now(),
      now()
      FROM legacy_source s
 LEFT JOIN item_uom_overrides o
        ON o.tenant_id = s.tenant_id
       AND o.item_id = s.item_id
       AND LOWER(o.from_uom) = s.from_uom
       AND LOWER(o.to_uom) = s.to_uom
       AND o.active = true
     WHERE o.id IS NULL
    ON CONFLICT (tenant_id, item_id, from_uom, to_uom) WHERE active = true
    DO NOTHING;

    WITH legacy_source AS (
      SELECT tenant_id,
             item_id,
             LOWER(from_uom) AS from_uom,
             LOWER(to_uom) AS to_uom,
             factor
        FROM uom_conversions
       WHERE factor > 0
         AND trim(from_uom) <> ''
         AND trim(to_uom) <> ''
    )
    UPDATE item_uom_overrides o
       SET multiplier = s.factor,
           updated_at = now()
      FROM legacy_source s
     WHERE o.tenant_id = s.tenant_id
       AND o.item_id = s.item_id
       AND LOWER(o.from_uom) = s.from_uom
       AND LOWER(o.to_uom) = s.to_uom
       AND o.active = true
       AND o.source = 'legacy_backfill'
       AND o.multiplier IS DISTINCT FROM s.factor;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_item_uom_overrides_dimension_guard ON item_uom_overrides;
    DROP FUNCTION IF EXISTS enforce_item_uom_override_dimension();

    DROP TRIGGER IF EXISTS trg_uom_aliases_prevent_collision ON uom_aliases;
    DROP FUNCTION IF EXISTS prevent_uom_alias_canonical_collision();

    DROP INDEX IF EXISTS idx_uom_aliases_alias_code_lower_unique;
    DROP INDEX IF EXISTS idx_uoms_code_lower_unique;

    ALTER TABLE item_uom_overrides
      DROP CONSTRAINT IF EXISTS chk_item_uom_overrides_source;

    ALTER TABLE item_uom_overrides
      DROP COLUMN IF EXISTS source;
  `);
}
