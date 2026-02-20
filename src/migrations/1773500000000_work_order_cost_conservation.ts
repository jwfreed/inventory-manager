import type { MigrationBuilder } from 'node-pg-migrate';

const SCRAP_REASON_CODES = "('scrap','work_order_scrap','reject','work_order_reject')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_work_order_cost_conservation()
    RETURNS trigger AS $$
    DECLARE
      v_execution_id uuid;
      v_execution record;
      v_component_cost numeric;
      v_fg_cost numeric;
      v_scrap_cost numeric;
      v_difference numeric;
    BEGIN
      v_execution_id := COALESCE(NEW.id, OLD.id);
      IF v_execution_id IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT id, tenant_id, status, production_movement_id
        INTO v_execution
        FROM work_order_executions
       WHERE id = v_execution_id;

      IF v_execution.id IS NULL THEN
        RETURN NULL;
      END IF;

      IF v_execution.status <> 'posted' OR v_execution.production_movement_id IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT COALESCE(SUM(clc.extended_cost), 0)::numeric
        INTO v_component_cost
        FROM cost_layer_consumptions clc
       WHERE clc.tenant_id = v_execution.tenant_id
         AND clc.wip_execution_id = v_execution.id
         AND clc.consumption_type = 'production_input';

      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
               AND lower(COALESCE(iml.reason_code, '')) NOT IN ${SCRAP_REASON_CODES}
              THEN COALESCE(
                iml.extended_cost,
                COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
              )
              ELSE 0
            END
          ),
          0
        )::numeric,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) > 0
               AND lower(COALESCE(iml.reason_code, '')) IN ${SCRAP_REASON_CODES}
              THEN COALESCE(
                iml.extended_cost,
                COALESCE(iml.quantity_delta_canonical, iml.quantity_delta) * COALESCE(iml.unit_cost, 0)
              )
              ELSE 0
            END
          ),
          0
        )::numeric
        INTO v_fg_cost, v_scrap_cost
        FROM inventory_movement_lines iml
       WHERE iml.tenant_id = v_execution.tenant_id
         AND iml.movement_id = v_execution.production_movement_id;

      v_difference := COALESCE(v_component_cost, 0) - COALESCE(v_fg_cost, 0) - COALESCE(v_scrap_cost, 0);

      IF abs(v_difference) > 1e-6 THEN
        RAISE EXCEPTION USING
          MESSAGE = 'WORK_ORDER_COST_CONSERVATION_FAILED',
          DETAIL = json_build_object(
            'workOrderExecutionId', v_execution.id,
            'productionMovementId', v_execution.production_movement_id,
            'totalComponentCost', COALESCE(v_component_cost, 0),
            'totalFgCost', COALESCE(v_fg_cost, 0),
            'scrapCost', COALESCE(v_scrap_cost, 0),
            'difference', v_difference
          )::text;
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_work_order_cost_conservation ON work_order_executions;
    CREATE CONSTRAINT TRIGGER trg_work_order_cost_conservation
      AFTER INSERT OR UPDATE ON work_order_executions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_work_order_cost_conservation();
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_clc_tenant_wip_execution_type
      ON cost_layer_consumptions (tenant_id, wip_execution_id, consumption_type)
      WHERE wip_execution_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS idx_clc_tenant_wip_execution_type;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_work_order_cost_conservation ON work_order_executions;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_work_order_cost_conservation();');
}
