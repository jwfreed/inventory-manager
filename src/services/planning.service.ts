import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type {
  kpiRollupInputsCreateSchema,
  kpiRunSchema,
  kpiSnapshotsCreateSchema,
  mpsDemandInputsCreateSchema,
  mpsPeriodSchema,
  mpsPeriodsCreateSchema,
  mpsPlanSchema,
  mrpGrossRequirementsCreateSchema,
  mrpItemPoliciesCreateSchema,
  mrpRunSchema,
  replenishmentPolicySchema,
} from '../schemas/planning.schema';

export type MpsPlanInput = z.infer<typeof mpsPlanSchema>;
export type MpsPeriodsCreateInput = z.infer<typeof mpsPeriodsCreateSchema>;
export type MpsPeriodInput = z.infer<typeof mpsPeriodSchema>;
export type MpsDemandInputsCreateInput = z.infer<typeof mpsDemandInputsCreateSchema>;
export type MrpRunInput = z.infer<typeof mrpRunSchema>;
export type MrpItemPoliciesCreateInput = z.infer<typeof mrpItemPoliciesCreateSchema>;
export type MrpGrossRequirementsCreateInput = z.infer<typeof mrpGrossRequirementsCreateSchema>;
export type ReplenishmentPolicyInput = z.infer<typeof replenishmentPolicySchema>;
export type KpiRunInput = z.infer<typeof kpiRunSchema>;
export type KpiSnapshotsCreateInput = z.infer<typeof kpiSnapshotsCreateSchema>;
export type KpiRollupInputsCreateInput = z.infer<typeof kpiRollupInputsCreateSchema>;

export function mapMpsPlan(row: any) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    bucketType: row.bucket_type,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMpsPlan(data: MpsPlanInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO mps_plans (id, code, status, bucket_type, starts_on, ends_on, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     RETURNING *`,
    [id, data.code, status, data.bucketType, data.startsOn, data.endsOn, data.notes ?? null, now],
  );
  return mapMpsPlan(res.rows[0]);
}

export async function listMpsPlans(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM mps_plans ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapMpsPlan);
}

export async function getMpsPlan(id: string) {
  const res = await query('SELECT * FROM mps_plans WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapMpsPlan(res.rows[0]);
}

export async function createMpsPeriods(planId: string, data: MpsPeriodsCreateInput) {
  return withTransaction(async (client) => {
    const plan = await client.query('SELECT 1 FROM mps_plans WHERE id = $1', [planId]);
    if (plan.rowCount === 0) {
      const err: any = new Error('MPS_PLAN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const period of data.periods) {
      const res = await client.query(
        `INSERT INTO mps_periods (id, mps_plan_id, period_start, period_end, sequence)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [uuidv4(), planId, period.periodStart, period.periodEnd, period.sequence],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listMpsPeriods(planId: string) {
  const { rows } = await query(
    `SELECT * FROM mps_periods WHERE mps_plan_id = $1 ORDER BY sequence ASC`,
    [planId],
  );
  return rows;
}

export async function createMpsDemandInputs(planId: string, data: MpsDemandInputsCreateInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const plan = await client.query('SELECT 1 FROM mps_plans WHERE id = $1', [planId]);
    if (plan.rowCount === 0) {
      const err: any = new Error('MPS_PLAN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const inserted: any[] = [];
    for (const input of data.inputs) {
      // Ensure the provided plan item belongs to the plan (avoid cross-plan writes).
      const scoped = await client.query(
        'SELECT 1 FROM mps_plan_items WHERE id = $1 AND mps_plan_id = $2',
        [input.mpsPlanItemId, planId],
      );
      if (scoped.rowCount === 0) {
        const err: any = new Error('MPS_PLAN_ITEM_NOT_IN_PLAN');
        err.code = 'BAD_REQUEST';
        throw err;
      }

      const res = await client.query(
        `INSERT INTO mps_demand_inputs (id, mps_plan_item_id, mps_period_id, demand_type, quantity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [uuidv4(), input.mpsPlanItemId, input.mpsPeriodId, input.demandType, input.quantity, now],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listMpsDemandInputs(planId: string) {
  const { rows } = await query(
    `SELECT mdi.*
     FROM mps_demand_inputs mdi
     JOIN mps_plan_items mpi ON mpi.id = mdi.mps_plan_item_id
     WHERE mpi.mps_plan_id = $1
     ORDER BY mdi.created_at DESC`,
    [planId],
  );
  return rows;
}

export async function listMpsPlanLines(planId: string) {
  const { rows } = await query(
    `SELECT mpl.*
     FROM mps_plan_lines mpl
     JOIN mps_plan_items mpi ON mpi.id = mpl.mps_plan_item_id
     WHERE mpi.mps_plan_id = $1
     ORDER BY mpl.mps_period_id ASC`,
    [planId],
  );
  return rows;
}

export function mapMrpRun(row: any) {
  return {
    id: row.id,
    mpsPlanId: row.mps_plan_id,
    status: row.status,
    asOf: row.as_of,
    bucketType: row.bucket_type,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function createMrpRun(data: MrpRunInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO mrp_runs (id, mps_plan_id, status, as_of, bucket_type, starts_on, ends_on, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [id, data.mpsPlanId, status, data.asOf, data.bucketType, data.startsOn, data.endsOn, data.notes ?? null, now],
  );
  return mapMrpRun(res.rows[0]);
}

export async function listMrpRuns(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM mrp_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapMrpRun);
}

export async function getMrpRun(id: string) {
  const res = await query('SELECT * FROM mrp_runs WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapMrpRun(res.rows[0]);
}

export async function createMrpItemPolicies(runId: string, data: MrpItemPoliciesCreateInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM mrp_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const policy of data.policies) {
      const res = await client.query(
        `INSERT INTO mrp_item_policies (
          id, mrp_run_id, item_id, uom, site_location_id, planning_lead_time_days, safety_stock_qty,
          lot_sizing_method, foq_qty, poq_periods, ppb_periods, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *`,
        [
          uuidv4(),
          runId,
          policy.itemId,
          policy.uom,
          policy.siteLocationId ?? null,
          policy.planningLeadTimeDays ?? null,
          policy.safetyStockQty ?? null,
          policy.lotSizingMethod,
          policy.foqQty ?? null,
          policy.poqPeriods ?? null,
          policy.ppbPeriods ?? null,
          now,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listMrpItemPolicies(runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_item_policies WHERE mrp_run_id = $1 ORDER BY created_at DESC`,
    [runId],
  );
  return rows;
}

export async function createMrpGrossRequirements(runId: string, data: MrpGrossRequirementsCreateInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM mrp_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const req of data.requirements) {
      const res = await client.query(
        `INSERT INTO mrp_gross_requirements (
          id, mrp_run_id, item_id, uom, site_location_id, period_start, source_type, source_ref, quantity, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *`,
        [
          uuidv4(),
          runId,
          req.itemId,
          req.uom,
          req.siteLocationId ?? null,
          req.periodStart,
          req.sourceType,
          req.sourceRef ?? null,
          req.quantity,
          now,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listMrpGrossRequirements(runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_gross_requirements WHERE mrp_run_id = $1 ORDER BY period_start ASC, created_at ASC`,
    [runId],
  );
  return rows;
}

export async function listMrpPlanLines(runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_plan_lines WHERE mrp_run_id = $1 ORDER BY period_start ASC`,
    [runId],
  );
  return rows;
}

export async function listMrpPlannedOrders(runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_planned_orders WHERE mrp_run_id = $1 ORDER BY release_date ASC, created_at ASC`,
    [runId],
  );
  return rows;
}

export function mapReplenishmentPolicy(row: any) {
  return {
    id: row.id,
    itemId: row.item_id,
    uom: row.uom,
    siteLocationId: row.site_location_id,
    policyType: row.policy_type,
    status: row.status,
    leadTimeDays: row.lead_time_days,
    demandRatePerDay: row.demand_rate_per_day,
    safetyStockMethod: row.safety_stock_method,
    safetyStockQty: row.safety_stock_qty,
    ppisPeriods: row.ppis_periods,
    reviewPeriodDays: row.review_period_days,
    orderUpToLevelQty: row.order_up_to_level_qty,
    reorderPointQty: row.reorder_point_qty,
    orderQuantityQty: row.order_quantity_qty,
    minOrderQty: row.min_order_qty,
    maxOrderQty: row.max_order_qty,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createReplenishmentPolicy(data: ReplenishmentPolicyInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'active';
  const res = await query(
    `INSERT INTO replenishment_policies (
      id, item_id, uom, site_location_id, policy_type, status, lead_time_days, demand_rate_per_day,
      safety_stock_method, safety_stock_qty, ppis_periods, review_period_days, order_up_to_level_qty,
      reorder_point_qty, order_quantity_qty, min_order_qty, max_order_qty, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
    RETURNING *`,
    [
      id,
      data.itemId,
      data.uom,
      data.siteLocationId ?? null,
      data.policyType,
      status,
      data.leadTimeDays ?? null,
      data.demandRatePerDay ?? null,
      data.safetyStockMethod,
      data.safetyStockQty ?? null,
      data.ppisPeriods ?? null,
      data.reviewPeriodDays ?? null,
      data.orderUpToLevelQty ?? null,
      data.reorderPointQty ?? null,
      data.orderQuantityQty ?? null,
      data.minOrderQty ?? null,
      data.maxOrderQty ?? null,
      data.notes ?? null,
      now,
    ],
  );
  return mapReplenishmentPolicy(res.rows[0]);
}

export async function listReplenishmentPolicies(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM replenishment_policies ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapReplenishmentPolicy);
}

export async function getReplenishmentPolicy(id: string) {
  const res = await query('SELECT * FROM replenishment_policies WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapReplenishmentPolicy(res.rows[0]);
}

export async function listReplenishmentRecommendations(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM replenishment_recommendations ORDER BY computed_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export function mapKpiRun(row: any) {
  return {
    id: row.id,
    status: row.status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    asOf: row.as_of,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function createKpiRun(data: KpiRunInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO kpi_runs (id, status, window_start, window_end, as_of, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [id, status, data.windowStart ?? null, data.windowEnd ?? null, data.asOf ?? null, data.notes ?? null, now],
  );
  return mapKpiRun(res.rows[0]);
}

export async function listKpiRuns(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM kpi_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapKpiRun);
}

export async function getKpiRun(id: string) {
  const res = await query('SELECT * FROM kpi_runs WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapKpiRun(res.rows[0]);
}

export async function createKpiSnapshots(runId: string, data: KpiSnapshotsCreateInput) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM kpi_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('KPI_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const snapshot of data.snapshots) {
      const res = await client.query(
        `INSERT INTO kpi_snapshots (id, kpi_run_id, kpi_name, dimensions, value, units, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         RETURNING *`,
        [
          uuidv4(),
          runId,
          snapshot.kpiName,
          snapshot.dimensions,
          snapshot.value ?? null,
          snapshot.units ?? null,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listKpiRunSnapshots(runId: string) {
  const { rows } = await query(
    `SELECT * FROM kpi_snapshots WHERE kpi_run_id = $1 ORDER BY computed_at DESC`,
    [runId],
  );
  return rows;
}

export async function listKpiSnapshots(filters: { kpiName?: string; from?: string; to?: string; limit: number; offset: number }) {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters.kpiName) {
    params.push(filters.kpiName);
    conditions.push(`kpi_name = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`computed_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`computed_at <= $${params.length}`);
  }
  params.push(filters.limit, filters.offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM kpi_snapshots ${where} ORDER BY computed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function createKpiRollupInputs(runId: string, data: KpiRollupInputsCreateInput) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM kpi_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('KPI_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const input of data.inputs) {
      const res = await client.query(
        `INSERT INTO kpi_rollup_inputs (id, kpi_run_id, metric_name, dimensions, numerator_qty, denominator_qty, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         RETURNING *`,
        [
          uuidv4(),
          runId,
          input.metricName,
          input.dimensions,
          input.numeratorQty ?? null,
          input.denominatorQty ?? null,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listKpiRollupInputs(runId: string) {
  const { rows } = await query(
    `SELECT * FROM kpi_rollup_inputs WHERE kpi_run_id = $1 ORDER BY computed_at DESC`,
    [runId],
  );
  return rows;
}

