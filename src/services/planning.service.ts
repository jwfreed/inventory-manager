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

/**
 * Subtract `days` from an ISO date string (YYYY-MM-DD) and return YYYY-MM-DD.
 * Uses UTC arithmetic to avoid DST ambiguity.
 */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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
      `SELECT id, starts_on, ends_on FROM mrp_runs WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (runRes.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const run = runRes.rows[0];

    // Load open SO lines within the planning horizon.
    const demandRes = await client.query(
      `SELECT sol.id AS so_line_id, sol.item_id, sol.uom, sol.quantity_ordered,
              so.requested_ship_date
         FROM sales_order_lines sol
         JOIN sales_orders so ON so.id = sol.sales_order_id AND so.tenant_id = sol.tenant_id
        WHERE sol.tenant_id = $1
          AND so.status IN ('submitted','partially_shipped')
          AND so.requested_ship_date IS NOT NULL
          AND so.requested_ship_date >= $2
          AND so.requested_ship_date <= $3
        ORDER BY so.requested_ship_date ASC`,
      [tenantId, run.starts_on, run.ends_on],
    );

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
         VALUES ($1,$2,$3,$4,$5,NULL,$6,'sales_orders',$7,$8,$9)`,
        [
          uuidv4(), tenantId, runId,
          row.item_id, row.uom,
          row.requested_ship_date, row.so_line_id,
          row.quantity_ordered,
          now,
        ],
      );
      loadedCount += 1;
    }

    return { loadedCount };
  });
}

/**
 * Net requirements netting algorithm for an MRP run.
 *
 * Algorithm (per item × uom):
 *   1. beginOnHand = available inventory (sellable locations only — excludes QA, HOLD, REJECT, SCRAP)
 *   2. For each period sorted by period_start:
 *        netReq = max(0, grossReq − beginOnHand − scheduledReceipts + safetyStock)
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
      `SELECT id, starts_on, ends_on, bucket_type, status
         FROM mrp_runs WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (runRes.rowCount === 0) {
      const err: any = new Error('MRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Aggregate gross requirements by (item_id, uom, period_start).
    const grossReqRes = await client.query(
      `SELECT item_id, uom, period_start::text AS period_start,
              SUM(quantity)::numeric AS quantity
         FROM mrp_gross_requirements
        WHERE mrp_run_id = $1
        GROUP BY item_id, uom, period_start
        ORDER BY item_id, uom, period_start ASC`,
      [runId],
    );

    // Aggregate scheduled receipts by (item_id, uom, period_start).
    const schedRes = await client.query(
      `SELECT item_id, uom, period_start::text AS period_start,
              SUM(quantity)::numeric AS quantity
         FROM mrp_scheduled_receipts
        WHERE mrp_run_id = $1
        GROUP BY item_id, uom, period_start`,
      [runId],
    );

    // Item policies for lot sizing and lead time.
    const policiesRes = await client.query(
      `SELECT item_id, uom,
              COALESCE(planning_lead_time_days, 0) AS lead_time_days,
              COALESCE(safety_stock_qty, 0)        AS safety_stock_qty,
              COALESCE(lot_sizing_method, 'l4l')   AS lot_sizing_method,
              COALESCE(foq_qty, 0)                 AS foq_qty
         FROM mrp_item_policies
        WHERE mrp_run_id = $1`,
      [runId],
    );

    const itemIds = [...new Set<string>(grossReqRes.rows.map((r: any) => r.item_id))];

    if (itemIds.length === 0) {
      // Nothing to net — mark computed and return.
      await client.query(`UPDATE mrp_runs SET status = 'computed' WHERE id = $1`, [runId]);
      return { planLinesCreated: 0, plannedOrdersCreated: 0 };
    }

    // Available inventory — SELLABLE locations only (excludes QA, HOLD, REJECT, SCRAP).
    // Uses inventory_available_location_sellable_v which enforces is_sellable = true.
    const availableRes = await client.query(
      `SELECT item_id, uom,
              COALESCE(SUM(available_qty), 0)::numeric AS available_qty
         FROM inventory_available_location_sellable_v
        WHERE tenant_id = $1
          AND item_id = ANY($2::uuid[])
        GROUP BY item_id, uom`,
      [tenantId, itemIds],
    );

    // Item metadata for order type derivation.
    const itemsRes = await client.query(
      `SELECT id, COALESCE(is_manufactured, false) AS is_manufactured
         FROM items
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, itemIds],
    );

    // ── Build lookup maps ────────────────────────────────────────────────────

    // availableMap: "itemId:uom" → available qty
    const availableMap = new Map<string, number>();
    for (const row of availableRes.rows) {
      availableMap.set(`${row.item_id}:${row.uom}`, toNumber(row.available_qty));
    }

    // policyMap: "itemId:uom" → policy row
    const policyMap = new Map<string, { leadTimeDays: number; safetyStockQty: number; lotSizingMethod: string; foqQty: number }>();
    for (const row of policiesRes.rows) {
      policyMap.set(`${row.item_id}:${row.uom}`, {
        leadTimeDays: toNumber(row.lead_time_days),
        safetyStockQty: toNumber(row.safety_stock_qty),
        lotSizingMethod: row.lot_sizing_method,
        foqQty: toNumber(row.foq_qty),
      });
    }

    // isManufacturedMap: itemId → boolean
    const isManufacturedMap = new Map<string, boolean>();
    for (const row of itemsRes.rows) {
      isManufacturedMap.set(row.id, Boolean(row.is_manufactured));
    }

    // grossMap: "itemId:uom" → Map<periodStart, qty>
    const grossMap = new Map<string, Map<string, number>>();
    for (const row of grossReqRes.rows) {
      const key = `${row.item_id}:${row.uom}`;
      if (!grossMap.has(key)) grossMap.set(key, new Map());
      grossMap.get(key)!.set(row.period_start, toNumber(row.quantity));
    }

    // schedMap: "itemId:uom" → Map<periodStart, qty>
    const schedMap = new Map<string, Map<string, number>>();
    for (const row of schedRes.rows) {
      const key = `${row.item_id}:${row.uom}`;
      if (!schedMap.has(key)) schedMap.set(key, new Map());
      const prev = schedMap.get(key)!.get(row.period_start) ?? 0;
      schedMap.get(key)!.set(row.period_start, prev + toNumber(row.quantity));
    }

    // ── Idempotent delete of prior results ───────────────────────────────────
    await client.query(`DELETE FROM mrp_plan_lines    WHERE mrp_run_id = $1`, [runId]);
    await client.query(`DELETE FROM mrp_planned_orders WHERE mrp_run_id = $1`, [runId]);

    const now = new Date();
    let planLinesCreated = 0;
    let plannedOrdersCreated = 0;

    // ── Net requirements — one pass per (item × uom) ─────────────────────────
    for (const [itemUomKey, demandByPeriod] of grossMap.entries()) {
      const [itemId, uom] = itemUomKey.split(':');
      const policy = policyMap.get(itemUomKey) ?? { leadTimeDays: 0, safetyStockQty: 0, lotSizingMethod: 'l4l', foqQty: 0 };
      const orderType = isManufacturedMap.get(itemId) ? 'planned_work_order' : 'planned_purchase_order';
      const schedByPeriod = schedMap.get(itemUomKey) ?? new Map<string, number>();

      // Sort periods ascending so we can carry forward projected on-hand.
      const periods = [...demandByPeriod.keys()].sort();

      let beginOnHand = availableMap.get(itemUomKey) ?? 0;

      for (const period of periods) {
        const grossReqQty = roundQuantity(demandByPeriod.get(period) ?? 0);
        const scheduledReceiptQty = roundQuantity(schedByPeriod.get(period) ?? 0);

        const netReqQty = roundQuantity(
          Math.max(0, grossReqQty - beginOnHand - scheduledReceiptQty + policy.safetyStockQty),
        );

        let plannedOrderReceiptQty = 0;
        if (netReqQty > 0) {
          plannedOrderReceiptQty = roundQuantity(
            applyLotSizing(netReqQty, policy.lotSizingMethod, policy.foqQty),
          );
        }

        const projectedEndOnHand = roundQuantity(
          beginOnHand + scheduledReceiptQty + plannedOrderReceiptQty - grossReqQty,
        );

        await client.query(
          `INSERT INTO mrp_plan_lines
             (id, tenant_id, mrp_run_id, item_id, uom, site_location_id, period_start,
              begin_on_hand_qty, gross_requirements_qty, scheduled_receipts_qty,
              net_requirements_qty, planned_order_receipt_qty, planned_order_release_qty,
              projected_end_on_hand_qty, computed_at)
           VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$11,$12,now())`,
          [
            uuidv4(), tenantId, runId, itemId, uom, period,
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
                quantity, release_date, receipt_date, source_ref, created_at)
             VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,NULL,$10)`,
            [
              uuidv4(), tenantId, runId, itemId, uom,
              orderType, plannedOrderReceiptQty,
              releaseDate, receiptDate, now,
            ],
          );
          plannedOrdersCreated += 1;
        }

        // Carry forward — can't go below zero.
        beginOnHand = Math.max(0, projectedEndOnHand);
      }
    }

    await client.query(`UPDATE mrp_runs SET status = 'computed' WHERE id = $1`, [runId]);

    return { planLinesCreated, plannedOrdersCreated };
  });
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
