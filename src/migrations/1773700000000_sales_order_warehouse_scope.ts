import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('sales_orders', {
    warehouse_id: { type: 'uuid', references: 'locations' }
  });

  pgm.sql(`
    UPDATE sales_orders
       SET warehouse_id = resolve_warehouse_for_location(tenant_id, ship_from_location_id)
     WHERE warehouse_id IS NULL
       AND ship_from_location_id IS NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE sales_orders
      ADD CONSTRAINT chk_sales_orders_warehouse_required
      CHECK (warehouse_id IS NOT NULL)
      NOT VALID;
  `);

  pgm.createIndex('sales_orders', ['tenant_id', 'warehouse_id'], {
    name: 'idx_sales_orders_tenant_warehouse'
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_sales_orders_enforce_warehouse_scope()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_resolved_warehouse uuid;
      v_has_reservations boolean;
    BEGIN
      IF NEW.warehouse_id IS NULL THEN
        RAISE EXCEPTION 'WAREHOUSE_SCOPE_REQUIRED';
      END IF;

      IF NEW.ship_from_location_id IS NOT NULL THEN
        v_resolved_warehouse := resolve_warehouse_for_location(NEW.tenant_id, NEW.ship_from_location_id);
        IF v_resolved_warehouse IS NULL OR v_resolved_warehouse <> NEW.warehouse_id THEN
          RAISE EXCEPTION 'WAREHOUSE_SCOPE_MISMATCH';
        END IF;
      END IF;

      IF TG_OP = 'UPDATE' AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
        SELECT EXISTS (
          SELECT 1
            FROM sales_order_lines sol
            JOIN inventory_reservations r
              ON r.tenant_id = sol.tenant_id
             AND r.demand_type = 'sales_order_line'
             AND r.demand_id = sol.id
           WHERE sol.tenant_id = OLD.tenant_id
             AND sol.sales_order_id = OLD.id
        ) INTO v_has_reservations;

        IF v_has_reservations THEN
          RAISE EXCEPTION 'WAREHOUSE_SCOPE_IMMUTABLE_AFTER_RESERVATION';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_sales_orders_enforce_warehouse_scope ON sales_orders;
    CREATE TRIGGER trg_sales_orders_enforce_warehouse_scope
    BEFORE INSERT OR UPDATE OF warehouse_id, ship_from_location_id
    ON sales_orders
    FOR EACH ROW
    EXECUTE FUNCTION trg_sales_orders_enforce_warehouse_scope();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_sales_orders_enforce_warehouse_scope ON sales_orders;');
  pgm.sql('DROP FUNCTION IF EXISTS trg_sales_orders_enforce_warehouse_scope();');
  pgm.dropIndex('sales_orders', ['tenant_id', 'warehouse_id'], {
    name: 'idx_sales_orders_tenant_warehouse',
    ifExists: true
  });
  pgm.sql('ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS chk_sales_orders_warehouse_required;');
  pgm.dropColumns('sales_orders', ['warehouse_id'], { ifExists: true });
}
