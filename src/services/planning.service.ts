import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import { getDerivedBackorderBatch } from './backorderDerivation.service';
import {
  computeCycleCoverageQty,
  computeEffectiveReorderPoint,
  computeEffectiveSafetyStockQty,
  computeInventoryPosition,
  computeRecommendedOrderQty,
  normalizePolicyType,
  validateReplenishmentPolicy,
  type NormalizedPolicyType
} from './replenishmentMath';
import {
  buildReplenishmentScopeKey,
  loadReplenishmentPositionBatch,
  type ReplenishmentPositionRow
} from './replenishmentPosition.service';
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

type MrpDemandMode = 'mps_only' | 'sales_orders_only' | 'combined';
type MrpPlannedOrderStatus = 'planned' | 'firmed' | 'released';

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
    demandMode: row.demand_mode,
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
  const demandMode: MrpDemandMode = data.demandMode ?? 'mps_only';
  const res = await query(
    `INSERT INTO mrp_runs (id, tenant_id, mps_plan_id, status, demand_mode, as_of, bucket_type, starts_on, ends_on, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      id,
      tenantId,
      data.mpsPlanId,
      status,
      demandMode,
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
    const run = await client.query(
      'SELECT id, demand_mode FROM mrp_runs WHERE id = $1 AND tenant_id = $2',
      [runId, tenantId]
    );
    if (run.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const demandMode = run.rows[0].demand_mode as MrpDemandMode;
    const locationIds = Array.from(
      new Set(
        data.requirements
          .map((req) => req.siteLocationId ?? null)
          .filter((locationId): locationId is string => Boolean(locationId))
      )
    );
    const sellableLocationIds = await loadSellableLocationIds(client, tenantId, locationIds);
    if (demandMode === 'combined') {
      const combinedRefs = data.requirements
        .filter((req) => req.sourceType === 'mps' || req.sourceType === 'sales_orders')
        .map((req) => req.sourceRef ?? null)
        .filter((sourceRef): sourceRef is string => Boolean(sourceRef));
      await assertCombinedTopLevelSourceRefsAvailable(client, runId, combinedRefs);
    }

    const inserted: any[] = [];
    for (const req of data.requirements) {
      assertMrpDemandModeAllowsSource(demandMode, req.sourceType);
      if (!req.siteLocationId) {
        const err: any = new Error('MRP_LOCATION_SCOPE_REQUIRED');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      if (!sellableLocationIds.has(req.siteLocationId)) {
        const err: any = new Error('MRP_SELLABLE_LOCATION_REQUIRED');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      if (req.sourceType === 'sales_orders' && !req.sourceRef) {
        const err: any = new Error('MRP_SALES_ORDER_SOURCE_REF_REQUIRED');
        err.code = 'BAD_REQUEST';
        throw err;
      }

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
    policyType: row.policy_type === 't_oul' ? 'min_max' : row.policy_type,
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
  const dbPolicyType = data.policyType === 'min_max' ? 't_oul' : data.policyType;
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
      dbPolicyType,
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
  normalizedPolicyType: NormalizedPolicyType;
  status: 'actionable' | 'not_needed' | 'invalid_policy' | 'inventory_unavailable';
  inputs: {
    leadTimeDays: number | null;
    demandRatePerDay: number | null;
    safetyStockMethod: string | null;
    safetyStockQty: number | null;
    ppisPeriods: number | null;
    reviewPeriodDays: number | null;
    reorderPointQty: number | null;
    orderUpToLevelQty: number | null;
    orderQuantityQty: number | null;
    minOrderQty: number | null;
    maxOrderQty: number | null;
    effectiveSafetyStockQty: number | null;
    effectiveReorderPointQty: number | null;
    reorderPointSource: 'explicit' | 'derived' | 'missing';
    cycleCoverageQty: number | null;
  };
  inventory: {
    itemId: string;
    locationId: string;
    uom: string;
    onHand: number;
    usableOnHand: number;
    reserved: number;
    available: number;
    held: number;
    rejected: number;
    nonUsable: number;
    onOrder: number;
    inTransit: number;
    backordered: number;
    inventoryPosition: number;
  };
  inventoryComponents: {
    openPurchaseSupply: number;
    acceptedPendingPutawaySupply: number;
    transferInboundSupply: number;
    qaHeldSupply: number;
    rejectedSupply: number;
  };
  recommendation: {
    reorderNeeded: boolean;
    recommendedOrderQty: number;
    recommendedOrderDate: string | null;
  };
  validationErrors: string[];
  assumptions: string[];
};

function defaultInventorySnapshot(itemId: string, locationId: string, uom: string) {
  return {
    itemId,
    locationId,
    uom,
    onHand: 0,
    usableOnHand: 0,
    reserved: 0,
    available: 0,
    held: 0,
    rejected: 0,
    nonUsable: 0,
    onOrder: 0,
    inTransit: 0,
    backordered: 0,
    inventoryPosition: 0
  };
}

function defaultInventoryComponents() {
  return {
    openPurchaseSupply: 0,
    acceptedPendingPutawaySupply: 0,
    transferInboundSupply: 0,
    qaHeldSupply: 0,
    rejectedSupply: 0
  };
}

async function resolveWarehouseScopeMap(tenantId: string, locationIds: string[]) {
  const entries = await Promise.all(
    locationIds.map(async (locationId) => {
      try {
        const warehouseId = await resolveWarehouseIdForLocation(tenantId, locationId);
        return [locationId, warehouseId] as const;
      } catch {
        return [locationId, null] as const;
      }
    })
  );
  return new Map(entries);
}

function mapPositionToInventory(position: ReplenishmentPositionRow, backorderedQty: number) {
  return {
    itemId: position.itemId,
    locationId: position.locationId,
    uom: position.uom,
    onHand: position.onHand,
    usableOnHand: position.usableOnHand,
    reserved: position.reservedCommitment,
    available: position.available,
    held: position.qaHeldSupply,
    rejected: position.rejectedSupply,
    nonUsable: roundQuantity(position.qaHeldSupply + position.rejectedSupply),
    onOrder: position.onOrder,
    inTransit: position.inTransit,
    backordered: backorderedQty,
    inventoryPosition: 0
  };
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
  const locationIds = Array.from(
    new Set(
      rows
        .map((row) => (typeof row.site_location_id === 'string' ? row.site_location_id : null))
        .filter((value): value is string => Boolean(value))
    )
  );
  const warehouseScopeByLocation = await resolveWarehouseScopeMap(tenantId, locationIds);

  const scopedRows = rows.map((row) => ({
    row,
    warehouseId: row.site_location_id ? warehouseScopeByLocation.get(row.site_location_id) ?? null : null
  }));
  const replenishmentKeys = scopedRows
    .filter(({ row, warehouseId }) => Boolean(row.site_location_id && warehouseId))
    .map(({ row, warehouseId }) => ({
      warehouseId: warehouseId!,
      itemId: row.item_id,
      locationId: row.site_location_id,
      uom: row.uom
    }));

  const { positionByScope, usableSupplyByScope, inboundSupplyByScope } = await loadReplenishmentPositionBatch(
    tenantId,
    replenishmentKeys
  );
  const backorderedByScope = await getDerivedBackorderBatch({
    tenantId,
    keys: replenishmentKeys,
    usableSupplyByScope,
    inboundSupplyByScope
  });
  const evaluatedAt = new Date().toISOString();

  for (const { row, warehouseId } of scopedRows) {
    const assumptions: string[] = [];
    const validationErrors = validateReplenishmentPolicy({
      policyType: row.policy_type,
      leadTimeDays: row.lead_time_days,
      demandRatePerDay: row.demand_rate_per_day,
      safetyStockMethod: row.safety_stock_method,
      safetyStockQty: row.safety_stock_qty,
      ppisPeriods: row.ppis_periods,
      reviewPeriodDays: row.review_period_days,
      reorderPointQty: row.reorder_point_qty,
      orderUpToLevelQty: row.order_up_to_level_qty,
      orderQuantityQty: row.order_quantity_qty,
      minOrderQty: row.min_order_qty,
      maxOrderQty: row.max_order_qty
    });
    const normalizedPolicyType = normalizePolicyType(row.policy_type);
    const effectiveReorderPoint = computeEffectiveReorderPoint({
      reorderPointQty: row.reorder_point_qty,
      leadTimeDays: row.lead_time_days,
      demandRatePerDay: row.demand_rate_per_day,
      safetyStockMethod: row.safety_stock_method,
      safetyStockQty: row.safety_stock_qty,
      ppisPeriods: row.ppis_periods
    });
    const effectiveSafetyStockQty = computeEffectiveSafetyStockQty({
      safetyStockMethod: row.safety_stock_method,
      safetyStockQty: row.safety_stock_qty
    });
    const cycleCoverageQty = computeCycleCoverageQty({
      safetyStockMethod: row.safety_stock_method,
      demandRatePerDay: row.demand_rate_per_day,
      ppisPeriods: row.ppis_periods
    });

    if (!row.site_location_id) {
      assumptions.push('Missing site/location on policy; cannot compute recommendation.');
      recommendations.push({
        policyId: row.id,
        itemId: row.item_id,
        locationId: '',
        uom: row.uom,
        policyType: row.policy_type,
        normalizedPolicyType,
        status: 'invalid_policy',
        inputs: {
          leadTimeDays: row.lead_time_days ?? null,
          demandRatePerDay: row.demand_rate_per_day ?? null,
          safetyStockMethod: row.safety_stock_method ?? null,
          safetyStockQty: row.safety_stock_qty ?? null,
          ppisPeriods: row.ppis_periods ?? null,
          reviewPeriodDays: row.review_period_days ?? null,
          reorderPointQty: row.reorder_point_qty ?? null,
          orderUpToLevelQty: row.order_up_to_level_qty ?? null,
          orderQuantityQty: row.order_quantity_qty ?? null,
          minOrderQty: row.min_order_qty ?? null,
          maxOrderQty: row.max_order_qty ?? null,
          effectiveSafetyStockQty,
          effectiveReorderPointQty: effectiveReorderPoint.value,
          reorderPointSource: effectiveReorderPoint.source,
          cycleCoverageQty
        },
        inventory: defaultInventorySnapshot(row.item_id, '', row.uom),
        inventoryComponents: defaultInventoryComponents(),
        recommendation: { reorderNeeded: false, recommendedOrderQty: 0, recommendedOrderDate: null },
        validationErrors: ['Policy site/location scope is required.'],
        assumptions
      });
      continue;
    }

    if (!warehouseId) {
      assumptions.push('Warehouse scope could not be resolved for the policy location.');
      recommendations.push({
        policyId: row.id,
        itemId: row.item_id,
        locationId: row.site_location_id,
        uom: row.uom,
        policyType: row.policy_type,
        normalizedPolicyType,
        status: 'inventory_unavailable',
        inputs: {
          leadTimeDays: row.lead_time_days ?? null,
          demandRatePerDay: row.demand_rate_per_day ?? null,
          safetyStockMethod: row.safety_stock_method ?? null,
          safetyStockQty: row.safety_stock_qty ?? null,
          ppisPeriods: row.ppis_periods ?? null,
          reviewPeriodDays: row.review_period_days ?? null,
          reorderPointQty: row.reorder_point_qty ?? null,
          orderUpToLevelQty: row.order_up_to_level_qty ?? null,
          orderQuantityQty: row.order_quantity_qty ?? null,
          minOrderQty: row.min_order_qty ?? null,
          maxOrderQty: row.max_order_qty ?? null,
          effectiveSafetyStockQty,
          effectiveReorderPointQty: effectiveReorderPoint.value,
          reorderPointSource: effectiveReorderPoint.source,
          cycleCoverageQty
        },
        inventory: defaultInventorySnapshot(row.item_id, row.site_location_id, row.uom),
        inventoryComponents: defaultInventoryComponents(),
        recommendation: { reorderNeeded: false, recommendedOrderQty: 0, recommendedOrderDate: null },
        validationErrors,
        assumptions
      });
      continue;
    }

    const scopeKey = buildReplenishmentScopeKey(tenantId, {
      warehouseId,
      itemId: row.item_id,
      locationId: row.site_location_id,
      uom: row.uom
    });
    const position = positionByScope.get(scopeKey);
    if (!position) {
      assumptions.push('Inventory position unavailable for the policy scope.');
      recommendations.push({
        policyId: row.id,
        itemId: row.item_id,
        locationId: row.site_location_id,
        uom: row.uom,
        policyType: row.policy_type,
        normalizedPolicyType,
        status: 'inventory_unavailable',
        inputs: {
          leadTimeDays: row.lead_time_days ?? null,
          demandRatePerDay: row.demand_rate_per_day ?? null,
          safetyStockMethod: row.safety_stock_method ?? null,
          safetyStockQty: row.safety_stock_qty ?? null,
          ppisPeriods: row.ppis_periods ?? null,
          reviewPeriodDays: row.review_period_days ?? null,
          reorderPointQty: row.reorder_point_qty ?? null,
          orderUpToLevelQty: row.order_up_to_level_qty ?? null,
          orderQuantityQty: row.order_quantity_qty ?? null,
          minOrderQty: row.min_order_qty ?? null,
          maxOrderQty: row.max_order_qty ?? null,
          effectiveSafetyStockQty,
          effectiveReorderPointQty: effectiveReorderPoint.value,
          reorderPointSource: effectiveReorderPoint.source,
          cycleCoverageQty
        },
        inventory: defaultInventorySnapshot(row.item_id, row.site_location_id, row.uom),
        inventoryComponents: defaultInventoryComponents(),
        recommendation: { reorderNeeded: false, recommendedOrderQty: 0, recommendedOrderDate: null },
        validationErrors,
        assumptions
      });
      continue;
    }

    const backorderedQty = backorderedByScope.get(scopeKey) ?? 0;
    const inventoryPosition = computeInventoryPosition({
      usableOnHand: position.usableOnHand,
      onOrder: position.onOrder,
      inTransit: position.inTransit,
      reservedCommitment: position.reservedCommitment,
      backorderedQty
    });
    const inventory = mapPositionToInventory(position, backorderedQty);
    inventory.inventoryPosition = inventoryPosition;

    const status: ReplenishmentRecommendation['status'] =
      validationErrors.length > 0 || effectiveReorderPoint.value == null ? 'invalid_policy' : 'not_needed';
    if (row.review_period_days != null) {
      assumptions.push('Review period is stored but periodic-review replenishment is not implemented in this path.');
    }
    if (String(row.safety_stock_method ?? '').toLowerCase() === 'ppis') {
      assumptions.push('PPIS is treated as cycle coverage metadata and does not inflate safety stock.');
    }
    if (effectiveReorderPoint.source === 'derived') {
      assumptions.push('Reorder point derived from demand rate, lead time, and fixed safety stock.');
    }

    let recommendation = { reorderNeeded: false, recommendedOrderQty: 0, recommendedOrderDate: null as string | null };
    let finalStatus: ReplenishmentRecommendation['status'] = status;
    if (validationErrors.length === 0 && effectiveReorderPoint.value !== null) {
      // invariant: replenishment decision must be traceable in a single execution path.
      // inventoryPosition, inbound supply, and derived backorder MUST use
      // identical scope dimensions.
      const reorderNeededBase = inventoryPosition <= effectiveReorderPoint.value;
      // TODO: when persisting recommendations or creating POs, use an idempotency
      // key derived from tenantId + warehouseId + itemId + locationId + uom + evaluationWindow.
      const recommendedOrderQty = reorderNeededBase
        ? computeRecommendedOrderQty({
            policy: {
              policyType: row.policy_type,
              orderQuantityQty: row.order_quantity_qty,
              orderUpToLevelQty: row.order_up_to_level_qty,
              minOrderQty: row.min_order_qty,
              maxOrderQty: row.max_order_qty
            },
            normalizedPolicyType,
            inventoryPosition,
            reorderPoint: effectiveReorderPoint.value
          })
        : 0;
      const reorderNeeded = reorderNeededBase && recommendedOrderQty > 0;
      recommendation = {
        reorderNeeded,
        recommendedOrderQty,
        recommendedOrderDate: reorderNeeded ? evaluatedAt : null
      };
      finalStatus = reorderNeeded ? 'actionable' : 'not_needed';
    }

    recommendations.push({
      policyId: row.id,
      itemId: row.item_id,
      locationId: row.site_location_id,
      uom: row.uom,
      policyType: row.policy_type,
      normalizedPolicyType,
      status: finalStatus,
      inputs: {
        leadTimeDays: row.lead_time_days ?? null,
        demandRatePerDay: row.demand_rate_per_day ?? null,
        safetyStockMethod: row.safety_stock_method ?? null,
        safetyStockQty: row.safety_stock_qty ?? null,
        ppisPeriods: row.ppis_periods ?? null,
        reviewPeriodDays: row.review_period_days ?? null,
        reorderPointQty: row.reorder_point_qty ?? null,
        orderUpToLevelQty: row.order_up_to_level_qty ?? null,
        orderQuantityQty: row.order_quantity_qty ?? null,
        minOrderQty: row.min_order_qty ?? null,
        maxOrderQty: row.max_order_qty ?? null,
        effectiveSafetyStockQty,
        effectiveReorderPointQty: effectiveReorderPoint.value,
        reorderPointSource: effectiveReorderPoint.source,
        cycleCoverageQty
      },
      inventory,
      inventoryComponents: {
        openPurchaseSupply: position.openPurchaseSupply,
        acceptedPendingPutawaySupply: position.acceptedPendingPutawaySupply,
        transferInboundSupply: position.transferInboundSupply,
        qaHeldSupply: position.qaHeldSupply,
        rejectedSupply: position.rejectedSupply
      },
      recommendation,
      validationErrors,
      assumptions
    });
  }

  return recommendations;
}

// ─── MRP Compute ─────────────────────────────────────────────────────────────

const MRP_PLANNING_SOURCE_TYPES = ['mrp', 'mrp_run', 'mrp_planned_order', 'planning'];

function buildMrpScopeKey(itemId: string, locationId: string, uom: string) {
  return `${itemId}:${locationId}:${uom}`;
}

function buildMrpPolicyKey(itemId: string, uom: string) {
  return `${itemId}:${uom}`;
}

function assertMrpDemandModeAllowsSource(demandMode: MrpDemandMode, sourceType: string) {
  if (sourceType === 'sales_orders' && demandMode === 'mps_only') {
    const err: any = new Error('MRP_DEMAND_MODE_CONFLICT');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (sourceType === 'mps' && demandMode === 'sales_orders_only') {
    const err: any = new Error('MRP_DEMAND_MODE_CONFLICT');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

async function loadSellableLocationIds(client: any, tenantId: string, locationIds: string[]) {
  if (locationIds.length === 0) {
    return new Set<string>();
  }
  const res = await client.query(
    `SELECT id
       FROM locations
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND is_sellable = true`,
    [tenantId, locationIds],
  );
  return new Set<string>(res.rows.map((row: any) => row.id));
}

async function assertCombinedTopLevelSourceRefsAvailable(client: any, runId: string, sourceRefs: string[]) {
  if (sourceRefs.length === 0) {
    return;
  }

  const seen = new Set<string>();
  for (const sourceRef of sourceRefs) {
    if (seen.has(sourceRef)) {
      const err: any = new Error('MRP_DUPLICATE_DEMAND_SOURCE_REF');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    seen.add(sourceRef);
  }

  const existing = await client.query(
    `SELECT source_ref
       FROM mrp_gross_requirements
      WHERE mrp_run_id = $1
        AND source_type IN ('mps', 'sales_orders')
        AND source_ref = ANY($2::text[])
      LIMIT 1`,
    [runId, sourceRefs],
  );
  if (existing.rowCount > 0) {
    const err: any = new Error('MRP_DUPLICATE_DEMAND_SOURCE_REF');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

async function assertMrpLocationScopedInputs(
  client: any,
  tenantId: string,
  runId: string,
  demandMode: MrpDemandMode,
) {
  const grossInvalid = await client.query(
    `SELECT gr.id,
            gr.site_location_id,
            COALESCE(l.is_sellable, false) AS is_sellable
       FROM mrp_gross_requirements gr
       LEFT JOIN locations l
         ON l.id = gr.site_location_id
        AND l.tenant_id = $2
      WHERE gr.mrp_run_id = $1
        AND (
          gr.source_type = 'bom_explosion'
          OR (gr.source_type = 'mps' AND $3 <> 'sales_orders_only')
          OR (gr.source_type = 'sales_orders' AND $3 <> 'mps_only')
        )
        AND (
          gr.site_location_id IS NULL
          OR l.id IS NULL
          OR l.is_sellable IS DISTINCT FROM true
        )
      LIMIT 1`,
    [runId, tenantId, demandMode],
  );
  if (grossInvalid.rowCount > 0) {
    const err: any = new Error(
      grossInvalid.rows[0].site_location_id ? 'MRP_SELLABLE_LOCATION_REQUIRED' : 'MRP_LOCATION_SCOPE_REQUIRED',
    );
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const scheduledInvalid = await client.query(
    `SELECT sr.id,
            sr.site_location_id,
            COALESCE(l.is_sellable, false) AS is_sellable
       FROM mrp_scheduled_receipts sr
       LEFT JOIN locations l
         ON l.id = sr.site_location_id
        AND l.tenant_id = $2
      WHERE sr.mrp_run_id = $1
        AND (
          sr.site_location_id IS NULL
          OR l.id IS NULL
          OR l.is_sellable IS DISTINCT FROM true
        )
      LIMIT 1`,
    [runId, tenantId],
  );
  if (scheduledInvalid.rowCount > 0) {
    const err: any = new Error(
      scheduledInvalid.rows[0].site_location_id ? 'MRP_SELLABLE_LOCATION_REQUIRED' : 'MRP_LOCATION_SCOPE_REQUIRED',
    );
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

async function assertCombinedDemandModeNoOverlap(client: any, runId: string, demandMode: MrpDemandMode) {
  if (demandMode !== 'combined') {
    return;
  }

  const overlap = await client.query(
    `SELECT source_ref
       FROM mrp_gross_requirements
      WHERE mrp_run_id = $1
        AND source_type IN ('mps', 'sales_orders')
        AND source_ref IS NOT NULL
      GROUP BY source_ref
     HAVING COUNT(*) FILTER (WHERE source_type = 'sales_orders') > 1
         OR COUNT(DISTINCT source_type) > 1
      LIMIT 1`,
    [runId],
  );
  if (overlap.rowCount > 0) {
    const err: any = new Error('MRP_DUPLICATE_DEMAND_SOURCE_REF');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

async function assertNoPlanningInventoryMutation(client: any, tenantId: string, refs: string[]) {
  if (refs.length === 0) {
    return;
  }
  const uniqueRefs = Array.from(new Set(refs));
  const res = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM inventory_movements
        WHERE tenant_id = $1
          AND (
            source_type = ANY($2::text[])
            OR source_id = ANY($3::text[])
          )
     ) AS exists`,
    [tenantId, MRP_PLANNING_SOURCE_TYPES, uniqueRefs],
  );
  if (res.rows[0]?.exists) {
    const err: any = new Error('MRP_PLANNING_MUTATION_FORBIDDEN');
    err.code = 'INVARIANT_VIOLATION';
    throw err;
  }
}

/**
 * Subtract `days` from an ISO date string (YYYY-MM-DD) and return YYYY-MM-DD.
 * Uses UTC arithmetic to avoid DST ambiguity.
 */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function addBucket(dateStr: string, bucketType: 'day' | 'week' | 'month'): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (bucketType === 'day') {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (bucketType === 'week') {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function buildMrpHorizonBuckets(
  startsOn: string,
  endsOn: string,
  bucketType: 'day' | 'week' | 'month',
): string[] {
  if (startsOn > endsOn) {
    return [];
  }
  const periods: string[] = [];
  let period = startsOn;
  while (period <= endsOn) {
    periods.push(period);
    period = addBucket(period, bucketType);
  }
  return periods;
}

/**
 * Apply lot-sizing policy to a net requirement quantity.
 * l4l  — lot-for-lot: order exactly what is needed.
 * foq  — fixed order quantity: round up to nearest multiple of foqQty.
 * poq/ppb — not implemented in WP8; fall back to l4l.
 */
function applyLotSizing(netReqQty: number, method: string, foqQty: number): number {
  if (method === 'foq' && foqQty > 0) {
    return Math.ceil(netReqQty / foqQty) * foqQty;
  }
  return netReqQty; // l4l, poq, ppb → l4l fallback
}

/**
 * Populate mrp_gross_requirements for a run from open sales order lines.
 *
 * INVARIANT: uses source_type = 'sales_orders'.
 * IDEMPOTENT: deletes existing 'sales_orders' rows for the run before inserting.
 * Only includes SO lines whose requested_ship_date falls within [run.starts_on, run.ends_on].
 */
export async function loadSalesOrderDemandIntoRun(tenantId: string, runId: string) {
  return withTransaction(async (client) => {
    const runRes = await client.query(
      `SELECT id, starts_on, ends_on, demand_mode
         FROM mrp_runs
        WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (runRes.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const run = runRes.rows[0];
    const demandMode = run.demand_mode as MrpDemandMode;
    assertMrpDemandModeAllowsSource(demandMode, 'sales_orders');

    const invalidScopeRes = await client.query(
      `SELECT sol.id AS so_line_id,
              so.ship_from_location_id,
              COALESCE(l.is_sellable, false) AS is_sellable
         FROM sales_order_lines sol
         JOIN sales_orders so
           ON so.id = sol.sales_order_id
          AND so.tenant_id = sol.tenant_id
         LEFT JOIN locations l
           ON l.id = so.ship_from_location_id
          AND l.tenant_id = so.tenant_id
        WHERE sol.tenant_id = $1
          AND so.status IN ('submitted','partially_shipped')
          AND so.requested_ship_date IS NOT NULL
          AND so.requested_ship_date >= $2
          AND so.requested_ship_date <= $3
          AND (
            so.ship_from_location_id IS NULL
            OR l.id IS NULL
            OR l.is_sellable IS DISTINCT FROM true
          )
        LIMIT 1`,
      [tenantId, run.starts_on, run.ends_on],
    );
    if ((invalidScopeRes.rowCount ?? 0) > 0) {
      const err: any = new Error(
        invalidScopeRes.rows[0].ship_from_location_id
          ? 'MRP_SELLABLE_LOCATION_REQUIRED'
          : 'MRP_LOCATION_SCOPE_REQUIRED',
      );
      err.code = 'BAD_REQUEST';
      throw err;
    }

    const demandRes = await client.query(
      `SELECT sol.id AS so_line_id,
              sol.item_id,
              sol.uom,
              so.ship_from_location_id AS site_location_id,
              so.requested_ship_date,
              GREATEST(
                sol.quantity_ordered
                - COALESCE(
                    SUM(
                      CASE
                        WHEN sos.inventory_movement_id IS NOT NULL THEN sosl.quantity_shipped
                        ELSE 0
                      END
                    ),
                    0
                  ),
                0
              )::numeric AS open_quantity
         FROM sales_order_lines sol
         JOIN sales_orders so
           ON so.id = sol.sales_order_id
          AND so.tenant_id = sol.tenant_id
         LEFT JOIN sales_order_shipment_lines sosl
           ON sosl.sales_order_line_id = sol.id
          AND sosl.tenant_id = sol.tenant_id
         LEFT JOIN sales_order_shipments sos
           ON sos.id = sosl.sales_order_shipment_id
          AND sos.tenant_id = sol.tenant_id
        WHERE sol.tenant_id = $1
          AND so.status IN ('submitted','partially_shipped')
          AND so.requested_ship_date IS NOT NULL
          AND so.requested_ship_date >= $2
          AND so.requested_ship_date <= $3
        GROUP BY
          sol.id,
          sol.item_id,
          sol.uom,
          sol.quantity_ordered,
          so.requested_ship_date,
          so.ship_from_location_id
       HAVING GREATEST(
                sol.quantity_ordered
                - COALESCE(
                    SUM(
                      CASE
                        WHEN sos.inventory_movement_id IS NOT NULL THEN sosl.quantity_shipped
                        ELSE 0
                      END
                    ),
                    0
                  ),
                0
              ) > 0
        ORDER BY so.requested_ship_date ASC, sol.id ASC`,
      [tenantId, run.starts_on, run.ends_on],
    );

    if (demandMode === 'combined') {
      await assertCombinedTopLevelSourceRefsAvailable(
        client,
        runId,
        demandRes.rows.map((row: any) => row.so_line_id),
      );
    }

    // Idempotent: remove prior load for this run.
    await client.query(
      `DELETE FROM mrp_gross_requirements WHERE mrp_run_id = $1 AND source_type = 'sales_orders'`,
      [runId],
    );

    const now = new Date();
    let loadedCount = 0;
    for (const row of demandRes.rows) {
      await client.query(
        `INSERT INTO mrp_gross_requirements
           (id, tenant_id, mrp_run_id, item_id, uom, site_location_id,
            period_start, source_type, source_ref, quantity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sales_orders',$8,$9,$10)`,
        [
          uuidv4(), tenantId, runId,
          row.item_id, row.uom,
          row.site_location_id,
          row.requested_ship_date, row.so_line_id,
          row.open_quantity,
          now,
        ],
      );
      loadedCount += 1;
    }

    await assertNoPlanningInventoryMutation(client, tenantId, [runId]);
    return { loadedCount };
  });
}

/**
 * Net requirements netting algorithm for an MRP run.
 *
 * Algorithm (per item × location × uom):
 *   1. beginOnHand = available inventory (sellable locations only — excludes QA, HOLD, REJECT, SCRAP)
 *   2. For each period sorted by period_start:
 *        netReq = max(0, grossReq + safetyStock − (beginOnHand + scheduledReceipts))
 *        if netReq > 0: create planned order (lot-sized); planned_order_release = period_start − leadTime
 *        projectedEndOnHand = beginOnHand + scheduledReceipts + plannedOrderReceipt − grossReq
 *        beginOnHand = max(0, projectedEndOnHand)   (carry forward)
 *
 * INVARIANT: does NOT write to inventory_movements or any inventory ledger table.
 * IDEMPOTENT: deletes mrp_plan_lines + mrp_planned_orders for the run then re-inserts.
 */
export async function computeMrpRun(tenantId: string, runId: string) {
  return withTransaction(async (client) => {
    const runRes = await client.query(
      `SELECT id, starts_on, ends_on, bucket_type, status, demand_mode
         FROM mrp_runs
        WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (runRes.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const run = runRes.rows[0];
    const demandMode = run.demand_mode as MrpDemandMode;

    await assertMrpLocationScopedInputs(client, tenantId, runId, demandMode);
    await assertCombinedDemandModeNoOverlap(client, runId, demandMode);

    const grossReqRes = await client.query(
      `SELECT item_id,
              uom,
              site_location_id,
              period_start::text AS period_start,
              SUM(quantity)::numeric AS quantity
         FROM mrp_gross_requirements
        WHERE mrp_run_id = $1
          AND (
            source_type = 'bom_explosion'
            OR (source_type = 'mps' AND $2 <> 'sales_orders_only')
            OR (source_type = 'sales_orders' AND $2 <> 'mps_only')
          )
        GROUP BY item_id, uom, site_location_id, period_start
        ORDER BY item_id, site_location_id, uom, period_start ASC`,
      [runId, demandMode],
    );

    const schedRes = await client.query(
      `SELECT item_id,
              uom,
              site_location_id,
              period_start::text AS period_start,
              SUM(quantity)::numeric AS quantity
         FROM mrp_scheduled_receipts
        WHERE mrp_run_id = $1
        GROUP BY item_id, uom, site_location_id, period_start`,
      [runId],
    );

    const policiesRes = await client.query(
      `SELECT item_id,
              uom,
              site_location_id,
              COALESCE(planning_lead_time_days, 0) AS lead_time_days,
              COALESCE(safety_stock_qty, 0)        AS safety_stock_qty,
              COALESCE(lot_sizing_method, 'l4l')   AS lot_sizing_method,
              COALESCE(foq_qty, 0)                 AS foq_qty
         FROM mrp_item_policies
        WHERE mrp_run_id = $1`,
      [runId],
    );

    const policyMap = new Map<string, { leadTimeDays: number; safetyStockQty: number; lotSizingMethod: string; foqQty: number }>();
    const defaultPolicyMap = new Map<string, { leadTimeDays: number; safetyStockQty: number; lotSizingMethod: string; foqQty: number }>();
    const scopeByKey = new Map<string, { itemId: string; locationId: string; uom: string }>();
    for (const row of policiesRes.rows) {
      const policy = {
        leadTimeDays: toNumber(row.lead_time_days),
        safetyStockQty: toNumber(row.safety_stock_qty),
        lotSizingMethod: row.lot_sizing_method,
        foqQty: toNumber(row.foq_qty),
      };
      if (row.site_location_id) {
        const scopeKey = buildMrpScopeKey(row.item_id, row.site_location_id, row.uom);
        policyMap.set(scopeKey, policy);
        if (policy.safetyStockQty > 0) {
          scopeByKey.set(scopeKey, { itemId: row.item_id, locationId: row.site_location_id, uom: row.uom });
        }
      } else {
        defaultPolicyMap.set(buildMrpPolicyKey(row.item_id, row.uom), policy);
      }
    }

    const isManufacturedMap = new Map<string, boolean>();
    const grossMap = new Map<string, Map<string, number>>();
    for (const row of grossReqRes.rows) {
      const key = buildMrpScopeKey(row.item_id, row.site_location_id, row.uom);
      if (!grossMap.has(key)) grossMap.set(key, new Map());
      scopeByKey.set(key, { itemId: row.item_id, locationId: row.site_location_id, uom: row.uom });
      grossMap.get(key)!.set(row.period_start, toNumber(row.quantity));
    }

    const schedMap = new Map<string, Map<string, number>>();
    for (const row of schedRes.rows) {
      const key = buildMrpScopeKey(row.item_id, row.site_location_id, row.uom);
      if (!schedMap.has(key)) schedMap.set(key, new Map());
      scopeByKey.set(key, { itemId: row.item_id, locationId: row.site_location_id, uom: row.uom });
      const prev = schedMap.get(key)!.get(row.period_start) ?? 0;
      schedMap.get(key)!.set(row.period_start, prev + toNumber(row.quantity));
    }

    const itemIds = [...new Set<string>([...scopeByKey.values()].map((scope) => scope.itemId))];

    if (itemIds.length === 0) {
      await client.query(`DELETE FROM mrp_plan_lines WHERE mrp_run_id = $1`, [runId]);
      await client.query(`DELETE FROM mrp_planned_orders WHERE mrp_run_id = $1`, [runId]);
      await client.query(`UPDATE mrp_runs SET status = 'computed' WHERE id = $1`, [runId]);
      await assertNoPlanningInventoryMutation(client, tenantId, [runId]);
      return { planLinesCreated: 0, plannedOrdersCreated: 0 };
    }

    const availableRes = await client.query(
      `SELECT item_id,
              location_id,
              uom,
              COALESCE(SUM(available_qty), 0)::numeric AS available_qty
         FROM inventory_available_location_sellable_v
        WHERE tenant_id = $1
          AND item_id = ANY($2::uuid[])
        GROUP BY item_id, location_id, uom`,
      [tenantId, itemIds],
    );

    const itemsRes = await client.query(
      `SELECT id, COALESCE(is_manufactured, false) AS is_manufactured
         FROM items
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, itemIds],
    );

    const availableMap = new Map<string, number>();
    for (const row of availableRes.rows) {
      availableMap.set(buildMrpScopeKey(row.item_id, row.location_id, row.uom), toNumber(row.available_qty));
    }

    for (const row of itemsRes.rows) {
      isManufacturedMap.set(row.id, Boolean(row.is_manufactured));
    }

    await client.query(`DELETE FROM mrp_plan_lines WHERE mrp_run_id = $1`, [runId]);
    await client.query(`DELETE FROM mrp_planned_orders WHERE mrp_run_id = $1`, [runId]);

    const now = new Date();
    const horizonPeriods = buildMrpHorizonBuckets(run.starts_on, run.ends_on, run.bucket_type);
    let planLinesCreated = 0;
    let plannedOrdersCreated = 0;

    for (const [scopeKey, scope] of scopeByKey.entries()) {
      const { itemId, locationId, uom } = scope;
      const policy =
        policyMap.get(scopeKey)
        ?? defaultPolicyMap.get(buildMrpPolicyKey(itemId, uom))
        ?? { leadTimeDays: 0, safetyStockQty: 0, lotSizingMethod: 'l4l', foqQty: 0 };
      const orderType = isManufacturedMap.get(itemId) ? 'planned_work_order' : 'planned_purchase_order';
      const demandByPeriod = grossMap.get(scopeKey) ?? new Map<string, number>();
      const schedByPeriod = schedMap.get(scopeKey) ?? new Map<string, number>();
      let beginOnHand = roundQuantity(availableMap.get(scopeKey) ?? 0);

      for (const period of horizonPeriods) {
        const grossReqQty = roundQuantity(demandByPeriod.get(period) ?? 0);
        const scheduledReceiptQty = roundQuantity(schedByPeriod.get(period) ?? 0);

        const netReqQty = roundQuantity(
          Math.max(0, grossReqQty + policy.safetyStockQty - (beginOnHand + scheduledReceiptQty)),
        );

        let plannedOrderReceiptQty = 0;
        if (netReqQty > 0) {
          plannedOrderReceiptQty = roundQuantity(
            applyLotSizing(netReqQty, policy.lotSizingMethod, policy.foqQty),
          );
        }

        const projectedEndOnHand = roundQuantity(
          Math.max(0, beginOnHand + scheduledReceiptQty + plannedOrderReceiptQty - grossReqQty),
        );
        if (projectedEndOnHand < (policy.safetyStockQty - 0.000001)) {
          const err: any = new Error('MRP_SAFETY_STOCK_INVARIANT');
          err.code = 'INVARIANT_VIOLATION';
          throw err;
        }

        const shouldPersistPlanLine = grossReqQty > 0 || scheduledReceiptQty > 0 || plannedOrderReceiptQty > 0;
        if (shouldPersistPlanLine) {
          await client.query(
            `INSERT INTO mrp_plan_lines
               (id, tenant_id, mrp_run_id, item_id, uom, site_location_id, period_start,
                begin_on_hand_qty, gross_requirements_qty, scheduled_receipts_qty,
                net_requirements_qty, planned_order_receipt_qty, planned_order_release_qty,
                projected_end_on_hand_qty, computed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,now())`,
            [
              uuidv4(), tenantId, runId, itemId, uom, locationId, period,
              beginOnHand, grossReqQty, scheduledReceiptQty,
              netReqQty, plannedOrderReceiptQty, projectedEndOnHand,
            ],
          );
          planLinesCreated += 1;

          if (plannedOrderReceiptQty > 0) {
            const receiptDate = period;
            const releaseDate = subtractDays(period, policy.leadTimeDays);
            await client.query(
              `INSERT INTO mrp_planned_orders
                 (id, tenant_id, mrp_run_id, item_id, uom, site_location_id, order_type,
                  status, quantity, release_date, receipt_date, source_ref, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'planned',$8,$9,$10,$11,$12)`,
              [
                uuidv4(), tenantId, runId, itemId, uom, locationId,
                orderType, plannedOrderReceiptQty,
                releaseDate, receiptDate, `${runId}:${itemId}:${locationId}:${period}`, now,
              ],
            );
            plannedOrdersCreated += 1;
          }
        }

        beginOnHand = roundQuantity(Math.max(0, projectedEndOnHand));
      }
    }

    await client.query(`UPDATE mrp_runs SET status = 'computed' WHERE id = $1`, [runId]);
    await assertNoPlanningInventoryMutation(client, tenantId, [runId]);
    return { planLinesCreated, plannedOrdersCreated };
  });
}

async function transitionPlannedOrderStatus(
  tenantId: string,
  orderId: string,
  expectedStatus: MrpPlannedOrderStatus,
  nextStatus: MrpPlannedOrderStatus,
) {
  return withTransaction(async (client) => {
    const currentRes = await client.query(
      `SELECT id, mrp_run_id, status
         FROM mrp_planned_orders
        WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId],
    );
    if (currentRes.rowCount === 0) {
      const err: any = new Error('MRP_PLANNED_ORDER_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const current = currentRes.rows[0];
    if (current.status !== expectedStatus) {
      const err: any = new Error('MRP_PLANNED_ORDER_INVALID_STATUS');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    const updated = await client.query(
      `UPDATE mrp_planned_orders
          SET status = $3
        WHERE id = $1
          AND tenant_id = $2
      RETURNING *`,
      [orderId, tenantId, nextStatus],
    );

    await assertNoPlanningInventoryMutation(client, tenantId, [orderId, current.mrp_run_id]);
    return updated.rows[0];
  });
}

export async function firmPlannedOrder(tenantId: string, orderId: string) {
  return transitionPlannedOrderStatus(tenantId, orderId, 'planned', 'firmed');
}

export async function releasePlannedOrder(tenantId: string, orderId: string) {
  return transitionPlannedOrderStatus(tenantId, orderId, 'firmed', 'released');
}

// ─── KPI Fill Rate ────────────────────────────────────────────────────────────

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
