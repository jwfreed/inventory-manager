import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { getInventorySnapshot } from './inventorySnapshot.service';
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
  fulfillmentFillRateQuerySchema
} from '../schemas/planning.schema';

export type MpsPlanInput = z.infer<typeof mpsPlanSchema>;
export type MpsPeriodsCreateInput = z.infer<typeof mpsPeriodsCreateSchema>;
export type MpsPeriodInput = z.infer<typeof mpsPeriodSchema>;
export type MpsDemandInputsCreateInput = z.infer<typeof mpsDemandInputsCreateSchema>;
export type MrpRunInput = z.infer<typeof mrpRunSchema>;
export type MrpItemPoliciesCreateInput = z.infer<typeof mrpItemPoliciesCreateSchema>;
export type MrpGrossRequirementsCreateInput = z.infer<typeof mrpGrossRequirementsCreateSchema>;
export type ReplenishmentPolicyInput = z.infer<typeof replenishmentPolicySchema>;
export type FulfillmentFillRateQuery = z.infer<typeof fulfillmentFillRateQuerySchema>;
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

export async function createMpsPlan(tenantId: string, data: MpsPlanInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO mps_plans (id, tenant_id, code, status, bucket_type, starts_on, ends_on, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     RETURNING *`,
    [id, tenantId, data.code, status, data.bucketType, data.startsOn, data.endsOn, data.notes ?? null, now],
  );
  return mapMpsPlan(res.rows[0]);
}

export async function listMpsPlans(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM mps_plans WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapMpsPlan);
}

export async function getMpsPlan(tenantId: string, id: string) {
  const res = await query('SELECT * FROM mps_plans WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapMpsPlan(res.rows[0]);
}

export async function createMpsPeriods(tenantId: string, planId: string, data: MpsPeriodsCreateInput) {
  return withTransaction(async (client) => {
    const plan = await client.query('SELECT 1 FROM mps_plans WHERE id = $1 AND tenant_id = $2', [
      planId,
      tenantId
    ]);
    if (plan.rowCount === 0) {
      const err: any = new Error('MPS_PLAN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const period of data.periods) {
      const res = await client.query(
        `INSERT INTO mps_periods (id, tenant_id, mps_plan_id, period_start, period_end, sequence)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [uuidv4(), tenantId, planId, period.periodStart, period.periodEnd, period.sequence],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listMpsPeriods(tenantId: string, planId: string) {
  const { rows } = await query(
    `SELECT * FROM mps_periods WHERE mps_plan_id = $1 AND tenant_id = $2 ORDER BY sequence ASC`,
    [planId, tenantId],
  );
  return rows;
}

export async function createMpsDemandInputs(
  tenantId: string,
  planId: string,
  data: MpsDemandInputsCreateInput
) {
  const now = new Date();
  return withTransaction(async (client) => {
    const plan = await client.query('SELECT 1 FROM mps_plans WHERE id = $1 AND tenant_id = $2', [
      planId,
      tenantId
    ]);
    if (plan.rowCount === 0) {
      const err: any = new Error('MPS_PLAN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const inserted: any[] = [];
    for (const input of data.inputs) {
      // Ensure the provided plan item belongs to the plan (avoid cross-plan writes).
      const scoped = await client.query(
        'SELECT 1 FROM mps_plan_items WHERE id = $1 AND mps_plan_id = $2 AND tenant_id = $3',
        [input.mpsPlanItemId, planId, tenantId],
      );
      if (scoped.rowCount === 0) {
        const err: any = new Error('MPS_PLAN_ITEM_NOT_IN_PLAN');
        err.code = 'BAD_REQUEST';
        throw err;
      }

      const res = await client.query(
        `INSERT INTO mps_demand_inputs (id, tenant_id, mps_plan_item_id, mps_period_id, demand_type, quantity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [uuidv4(), tenantId, input.mpsPlanItemId, input.mpsPeriodId, input.demandType, input.quantity, now],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listMpsDemandInputs(tenantId: string, planId: string) {
  const { rows } = await query(
    `SELECT mdi.*
     FROM mps_demand_inputs mdi
     JOIN mps_plan_items mpi ON mpi.id = mdi.mps_plan_item_id
     WHERE mpi.mps_plan_id = $1 AND mpi.tenant_id = $2
     ORDER BY mdi.created_at DESC`,
    [planId, tenantId],
  );
  return rows;
}

export async function listMpsPlanLines(tenantId: string, planId: string) {
  const { rows } = await query(
    `SELECT mpl.*
     FROM mps_plan_lines mpl
     JOIN mps_plan_items mpi ON mpi.id = mpl.mps_plan_item_id
     WHERE mpi.mps_plan_id = $1 AND mpi.tenant_id = $2
     ORDER BY mpl.mps_period_id ASC`,
    [planId, tenantId],
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

export async function createMrpRun(tenantId: string, data: MrpRunInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO mrp_runs (id, tenant_id, mps_plan_id, status, as_of, bucket_type, starts_on, ends_on, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      tenantId,
      data.mpsPlanId,
      status,
      data.asOf,
      data.bucketType,
      data.startsOn,
      data.endsOn,
      data.notes ?? null,
      now
    ],
  );
  return mapMrpRun(res.rows[0]);
}

export async function listMrpRuns(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM mrp_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapMrpRun);
}

export async function getMrpRun(tenantId: string, id: string) {
  const res = await query('SELECT * FROM mrp_runs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapMrpRun(res.rows[0]);
}

export async function createMrpItemPolicies(tenantId: string, runId: string, data: MrpItemPoliciesCreateInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM mrp_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const policy of data.policies) {
      const res = await client.query(
        `INSERT INTO mrp_item_policies (
          id, tenant_id, mrp_run_id, item_id, uom, site_location_id, planning_lead_time_days, safety_stock_qty,
          lot_sizing_method, foq_qty, poq_periods, ppb_periods, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
        [
          uuidv4(),
          tenantId,
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

export async function listMrpItemPolicies(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_item_policies WHERE mrp_run_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [runId, tenantId],
  );
  return rows;
}

export async function createMrpGrossRequirements(
  tenantId: string,
  runId: string,
  data: MrpGrossRequirementsCreateInput
) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM mrp_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const req of data.requirements) {
      const res = await client.query(
        `INSERT INTO mrp_gross_requirements (
          id, tenant_id, mrp_run_id, item_id, uom, site_location_id, period_start, source_type, source_ref, quantity, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          uuidv4(),
          tenantId,
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

export async function listMrpGrossRequirements(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_gross_requirements WHERE mrp_run_id = $1 AND tenant_id = $2 ORDER BY period_start ASC, created_at ASC`,
    [runId, tenantId],
  );
  return rows;
}

export async function listMrpPlanLines(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_plan_lines WHERE mrp_run_id = $1 AND tenant_id = $2 ORDER BY period_start ASC`,
    [runId, tenantId],
  );
  return rows;
}

export async function listMrpPlannedOrders(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM mrp_planned_orders WHERE mrp_run_id = $1 AND tenant_id = $2 ORDER BY release_date ASC, created_at ASC`,
    [runId, tenantId],
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

export async function createReplenishmentPolicy(tenantId: string, data: ReplenishmentPolicyInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'active';
  const res = await query(
    `INSERT INTO replenishment_policies (
      id, tenant_id, item_id, uom, site_location_id, policy_type, status, lead_time_days, demand_rate_per_day,
      safety_stock_method, safety_stock_qty, ppis_periods, review_period_days, order_up_to_level_qty,
      reorder_point_qty, order_quantity_qty, min_order_qty, max_order_qty, notes, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
    RETURNING *`,
    [
      id,
      tenantId,
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

export async function listReplenishmentPolicies(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM replenishment_policies WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapReplenishmentPolicy);
}

export async function getReplenishmentPolicy(tenantId: string, id: string) {
  const res = await query('SELECT * FROM replenishment_policies WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapReplenishmentPolicy(res.rows[0]);
}

export async function listReplenishmentRecommendations(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM replenishment_recommendations WHERE tenant_id = $1 ORDER BY computed_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
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

export async function createKpiRun(tenantId: string, data: KpiRunInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO kpi_runs (id, tenant_id, status, window_start, window_end, as_of, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [id, tenantId, status, data.windowStart ?? null, data.windowEnd ?? null, data.asOf ?? null, data.notes ?? null, now],
  );
  return mapKpiRun(res.rows[0]);
}

export async function listKpiRuns(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM kpi_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapKpiRun);
}

export async function getKpiRun(tenantId: string, id: string) {
  const res = await query('SELECT * FROM kpi_runs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapKpiRun(res.rows[0]);
}

export async function createKpiSnapshots(
  tenantId: string,
  runId: string,
  data: KpiSnapshotsCreateInput
) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM kpi_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('KPI_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const snapshot of data.snapshots) {
      const res = await client.query(
        `INSERT INTO kpi_snapshots (id, tenant_id, kpi_run_id, kpi_name, dimensions, value, units, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         RETURNING *`,
        [
          uuidv4(),
          tenantId,
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

export async function listKpiRunSnapshots(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM kpi_snapshots WHERE kpi_run_id = $1 AND tenant_id = $2 ORDER BY computed_at DESC`,
    [runId, tenantId],
  );
  return rows;
}

export async function listKpiSnapshots(
  tenantId: string,
  filters: { kpiName?: string; from?: string; to?: string; limit: number; offset: number }
) {
  const conditions: string[] = ['tenant_id = $1'];
  const params: any[] = [tenantId];
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

export async function createKpiRollupInputs(
  tenantId: string,
  runId: string,
  data: KpiRollupInputsCreateInput
) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM kpi_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('KPI_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const inserted: any[] = [];
    for (const input of data.inputs) {
      const res = await client.query(
        `INSERT INTO kpi_rollup_inputs (id, tenant_id, kpi_run_id, metric_name, dimensions, numerator_qty, denominator_qty, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         RETURNING *`,
        [
          uuidv4(),
          tenantId,
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

export async function listKpiRollupInputs(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM kpi_rollup_inputs WHERE kpi_run_id = $1 AND tenant_id = $2 ORDER BY computed_at DESC`,
    [runId, tenantId],
  );
  return rows;
}

type ReplenishmentRecommendation = {
  policyId: string;
  itemId: string;
  locationId: string;
  uom: string;
  policyType: string;
  inputs: {
    leadTimeDays: number | null;
    reorderPointQty: number | null;
    orderUpToLevelQty: number | null;
    orderQuantityQty: number | null;
    minOrderQty: number | null;
    maxOrderQty: number | null;
  };
  inventory: any;
  recommendation: {
    reorderNeeded: boolean;
    recommendedOrderQty: number;
    recommendedOrderDate: string | null;
  };
  assumptions: string[];
};

function defaultInventorySnapshot(itemId: string, locationId: string, uom: string) {
  return {
    itemId,
    locationId,
    uom,
    onHand: 0,
    reserved: 0,
    available: 0,
    onOrder: 0,
    inTransit: 0,
    backordered: 0,
    inventoryPosition: 0
  };
}

function applyMinMax(qty: number, minOrder: number | null, maxOrder: number | null, assumptions: string[]) {
  let result = qty;
  if (minOrder !== null && result < minOrder) {
    result = minOrder;
    assumptions.push(`Applied min order quantity (${minOrder}).`);
  }
  if (maxOrder !== null && result > maxOrder) {
    result = maxOrder;
    assumptions.push(`Applied max order quantity (${maxOrder}).`);
  }
  return roundQuantity(result);
}

function computeQropRecommendation(
  policy: any,
  snapshot: any,
  assumptions: string[]
): { reorderNeeded: boolean; recommendedOrderQty: number; recommendedOrderDate: string | null } {
  const reorderPoint = toNumber(policy.reorder_point_qty ?? 0);
  const orderQty = policy.order_quantity_qty != null ? toNumber(policy.order_quantity_qty) : null;
  const inventoryPosition = toNumber(snapshot.inventoryPosition ?? 0);
  const minOrder = policy.min_order_qty != null ? toNumber(policy.min_order_qty) : null;
  const maxOrder = policy.max_order_qty != null ? toNumber(policy.max_order_qty) : null;

  const reorderNeeded = inventoryPosition < reorderPoint;
  if (!reorderNeeded) {
    return { reorderNeeded, recommendedOrderQty: 0, recommendedOrderDate: null };
  }

  const suggested = orderQty != null ? orderQty : Math.max(0, reorderPoint - inventoryPosition);
  const recommendedOrderQty = applyMinMax(roundQuantity(suggested), minOrder, maxOrder, assumptions);
  return { reorderNeeded, recommendedOrderQty, recommendedOrderDate: null };
}

function computeToulRecommendation(
  policy: any,
  snapshot: any,
  assumptions: string[]
): { reorderNeeded: boolean; recommendedOrderQty: number; recommendedOrderDate: string | null } {
  const target = toNumber(policy.order_up_to_level_qty ?? 0);
  const inventoryPosition = toNumber(snapshot.inventoryPosition ?? 0);
  const minOrder = policy.min_order_qty != null ? toNumber(policy.min_order_qty) : null;
  const maxOrder = policy.max_order_qty != null ? toNumber(policy.max_order_qty) : null;

  let recommendedOrderQty = roundQuantity(Math.max(0, target - inventoryPosition));
  const reorderNeeded = recommendedOrderQty > 0;
  recommendedOrderQty = applyMinMax(recommendedOrderQty, minOrder, maxOrder, assumptions);
  return { reorderNeeded, recommendedOrderQty, recommendedOrderDate: null };
}

export async function computeReplenishmentRecommendations(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM replenishment_policies
     WHERE status = 'active' AND tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  const recommendations: ReplenishmentRecommendation[] = [];

  for (const row of rows) {
    const assumptions: string[] = [];

    if (!row.site_location_id) {
      assumptions.push('Missing site/location on policy; cannot compute recommendation.');
      recommendations.push({
        policyId: row.id,
        itemId: row.item_id,
        locationId: '',
        uom: row.uom,
        policyType: row.policy_type,
        inputs: {
          leadTimeDays: row.lead_time_days ?? null,
          reorderPointQty: row.reorder_point_qty ?? null,
          orderUpToLevelQty: row.order_up_to_level_qty ?? null,
          orderQuantityQty: row.order_quantity_qty ?? null,
          minOrderQty: row.min_order_qty ?? null,
          maxOrderQty: row.max_order_qty ?? null
        },
        inventory: defaultInventorySnapshot(row.item_id, '', row.uom),
        recommendation: { reorderNeeded: false, recommendedOrderQty: 0, recommendedOrderDate: null },
        assumptions
      });
      continue;
    }

    let snapshot = defaultInventorySnapshot(row.item_id, row.site_location_id, row.uom);
    try {
      const snap = await getInventorySnapshot(tenantId, {
        itemId: row.item_id,
        locationId: row.site_location_id,
        uom: row.uom
      });
      if (snap.length > 0) {
        snapshot = snap[0];
      }
    } catch (err) {
      assumptions.push('Inventory snapshot unavailable; defaulting to zero.');
    }

    let recommendation;
    if (row.policy_type === 'q_rop') {
      recommendation = computeQropRecommendation(row, snapshot, assumptions);
    } else {
      recommendation = computeToulRecommendation(row, snapshot, assumptions);
    }

    recommendations.push({
      policyId: row.id,
      itemId: row.item_id,
      locationId: row.site_location_id,
      uom: row.uom,
      policyType: row.policy_type,
      inputs: {
        leadTimeDays: row.lead_time_days ?? null,
        reorderPointQty: row.reorder_point_qty ?? null,
        orderUpToLevelQty: row.order_up_to_level_qty ?? null,
        orderQuantityQty: row.order_quantity_qty ?? null,
        minOrderQty: row.min_order_qty ?? null,
        maxOrderQty: row.max_order_qty ?? null
      },
      inventory: snapshot,
      recommendation,
      assumptions
    });
  }

  return recommendations;
}

export async function computeFulfillmentFillRate(
  tenantId: string,
  queryWindow: FulfillmentFillRateQuery
) {
  const params: any[] = [tenantId];
  const conditions: string[] = ['s.tenant_id = $1'];
  if (queryWindow.from) {
    params.push(queryWindow.from);
    conditions.push(`s.shipped_at >= $${params.length}`);
  }
  if (queryWindow.to) {
    params.push(queryWindow.to);
    conditions.push(`s.shipped_at <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT
        COALESCE(SUM(sol.quantity_ordered), 0) AS ordered_qty,
        COALESCE(SUM(sosl.quantity_shipped), 0) AS shipped_qty
     FROM sales_order_shipment_lines sosl
     JOIN sales_order_shipments s ON s.id = sosl.sales_order_shipment_id AND s.tenant_id = sosl.tenant_id
     JOIN sales_order_lines sol ON sol.id = sosl.sales_order_line_id AND sol.tenant_id = s.tenant_id
     ${where}`,
    params
  );

  const orderedQty = roundQuantity(toNumber(rows[0]?.ordered_qty ?? 0));
  const shippedQty = roundQuantity(toNumber(rows[0]?.shipped_qty ?? 0));
  const assumptions: string[] = [];
  if (orderedQty <= 0) {
    assumptions.push('No shipped order lines in the window; fill rate not measurable.');
  }
  const fillRate = orderedQty > 0 ? roundQuantity(shippedQty / orderedQty) : null;
  return {
    metricName: 'Fulfillment Fill Rate (measured)',
    shippedQty,
    requestedQty: orderedQty,
    fillRate,
    window: { from: queryWindow.from ?? null, to: queryWindow.to ?? null },
    assumptions
  };
}
