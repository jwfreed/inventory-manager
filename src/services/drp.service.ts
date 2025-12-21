import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type {
  drpGrossRequirementsCreateSchema,
  drpItemPoliciesCreateSchema,
  drpLaneSchema,
  drpNodeSchema,
  drpPeriodsCreateSchema,
  drpRunSchema,
} from '../schemas/drp.schema';

export type DrpNodeInput = z.infer<typeof drpNodeSchema>;
export type DrpLaneInput = z.infer<typeof drpLaneSchema>;
export type DrpRunInput = z.infer<typeof drpRunSchema>;
export type DrpPeriodsInput = z.infer<typeof drpPeriodsCreateSchema>;
export type DrpItemPoliciesInput = z.infer<typeof drpItemPoliciesCreateSchema>;
export type DrpGrossRequirementsInput = z.infer<typeof drpGrossRequirementsCreateSchema>;

export function mapNode(row: any) {
  return {
    id: row.id,
    code: row.code,
    locationId: row.location_id,
    nodeType: row.node_type,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapLane(row: any) {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    transferLeadTimeDays: row.transfer_lead_time_days,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRun(row: any) {
  return {
    id: row.id,
    status: row.status,
    bucketType: row.bucket_type,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    asOf: row.as_of,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function createDrpNode(tenantId: string, data: DrpNodeInput) {
  const id = uuidv4();
  const now = new Date();
  const active = data.active ?? true;
  const res = await query(
    `INSERT INTO drp_nodes (id, tenant_id, code, location_id, node_type, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING *`,
    [id, tenantId, data.code, data.locationId, data.nodeType, active, now],
  );
  return mapNode(res.rows[0]);
}

export async function listDrpNodes(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_nodes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapNode);
}

export async function getDrpNode(tenantId: string, id: string) {
  const res = await query('SELECT * FROM drp_nodes WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapNode(res.rows[0]);
}

export async function createDrpLane(tenantId: string, data: DrpLaneInput) {
  const id = uuidv4();
  const now = new Date();
  const active = data.active ?? true;
  const res = await query(
    `INSERT INTO drp_lanes (id, tenant_id, from_node_id, to_node_id, transfer_lead_time_days, active, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     RETURNING *`,
    [id, tenantId, data.fromNodeId, data.toNodeId, data.transferLeadTimeDays, active, data.notes ?? null, now],
  );
  return mapLane(res.rows[0]);
}

export async function listDrpLanes(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_lanes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapLane);
}

export async function getDrpLane(tenantId: string, id: string) {
  const res = await query('SELECT * FROM drp_lanes WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapLane(res.rows[0]);
}

export async function createDrpRun(tenantId: string, data: DrpRunInput) {
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO drp_runs (id, tenant_id, status, bucket_type, starts_on, ends_on, as_of, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [id, tenantId, status, data.bucketType, data.startsOn, data.endsOn, data.asOf, data.notes ?? null],
  );
  return mapRun(res.rows[0]);
}

export async function listDrpRuns(tenantId: string, limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return rows.map(mapRun);
}

export async function getDrpRun(tenantId: string, id: string) {
  const res = await query('SELECT * FROM drp_runs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (res.rowCount === 0) return null;
  return mapRun(res.rows[0]);
}

export async function createDrpPeriods(tenantId: string, runId: string, data: DrpPeriodsInput) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const rows: any[] = [];
    for (const period of data.periods) {
      const res = await client.query(
        `INSERT INTO drp_periods (id, tenant_id, drp_run_id, period_start, period_end, sequence)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [uuidv4(), tenantId, runId, period.periodStart, period.periodEnd, period.sequence],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listDrpPeriods(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_periods WHERE drp_run_id = $1 AND tenant_id = $2 ORDER BY sequence ASC`,
    [runId, tenantId],
  );
  return rows;
}

export async function createDrpItemPolicies(tenantId: string, runId: string, data: DrpItemPoliciesInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const inserted: any[] = [];
    for (const policy of data.policies) {
      const res = await client.query(
        `INSERT INTO drp_item_policies
         (id, tenant_id, drp_run_id, to_node_id, preferred_from_node_id, item_id, uom, safety_stock_qty, lot_sizing_method, foq_qty, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          uuidv4(),
          tenantId,
          runId,
          policy.toNodeId,
          policy.preferredFromNodeId ?? null,
          policy.itemId,
          policy.uom,
          policy.safetyStockQty ?? null,
          policy.lotSizingMethod,
          policy.foqQty ?? null,
          now,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listDrpItemPolicies(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_item_policies WHERE drp_run_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
    [runId, tenantId],
  );
  return rows;
}

export async function createDrpGrossRequirements(
  tenantId: string,
  runId: string,
  data: DrpGrossRequirementsInput
) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const rows: any[] = [];
    for (const req of data.requirements) {
      const res = await client.query(
        `INSERT INTO drp_gross_requirements
         (id, tenant_id, drp_run_id, to_node_id, item_id, uom, period_start, source_type, source_ref, quantity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          uuidv4(),
          tenantId,
          runId,
          req.toNodeId,
          req.itemId,
          req.uom,
          req.periodStart,
          req.sourceType,
          req.sourceRef ?? null,
          req.quantity,
          now,
        ],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listDrpGrossRequirements(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_gross_requirements WHERE drp_run_id = $1 AND tenant_id = $2 ORDER BY period_start ASC, created_at DESC`,
    [runId, tenantId],
  );
  return rows;
}

export async function listDrpPlanLines(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_plan_lines WHERE drp_run_id = $1 AND tenant_id = $2 ORDER BY period_start ASC`,
    [runId, tenantId],
  );
  return rows;
}

export async function listDrpPlannedTransfers(tenantId: string, runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_planned_transfers WHERE drp_run_id = $1 AND tenant_id = $2 ORDER BY release_date ASC`,
    [runId, tenantId],
  );
  return rows;
}
