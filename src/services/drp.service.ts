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

export async function createDrpNode(data: DrpNodeInput) {
  const id = uuidv4();
  const now = new Date();
  const active = data.active ?? true;
  const res = await query(
    `INSERT INTO drp_nodes (id, code, location_id, node_type, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)
     RETURNING *`,
    [id, data.code, data.locationId, data.nodeType, active, now],
  );
  return mapNode(res.rows[0]);
}

export async function listDrpNodes(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_nodes ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapNode);
}

export async function getDrpNode(id: string) {
  const res = await query('SELECT * FROM drp_nodes WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapNode(res.rows[0]);
}

export async function createDrpLane(data: DrpLaneInput) {
  const id = uuidv4();
  const now = new Date();
  const active = data.active ?? true;
  const res = await query(
    `INSERT INTO drp_lanes (id, from_node_id, to_node_id, transfer_lead_time_days, active, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING *`,
    [id, data.fromNodeId, data.toNodeId, data.transferLeadTimeDays, active, data.notes ?? null, now],
  );
  return mapLane(res.rows[0]);
}

export async function listDrpLanes(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_lanes ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapLane);
}

export async function getDrpLane(id: string) {
  const res = await query('SELECT * FROM drp_lanes WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapLane(res.rows[0]);
}

export async function createDrpRun(data: DrpRunInput) {
  const id = uuidv4();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO drp_runs (id, status, bucket_type, starts_on, ends_on, as_of, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [id, status, data.bucketType, data.startsOn, data.endsOn, data.asOf, data.notes ?? null],
  );
  return mapRun(res.rows[0]);
}

export async function listDrpRuns(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM drp_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapRun);
}

export async function getDrpRun(id: string) {
  const res = await query('SELECT * FROM drp_runs WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapRun(res.rows[0]);
}

export async function createDrpPeriods(runId: string, data: DrpPeriodsInput) {
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const rows: any[] = [];
    for (const period of data.periods) {
      const res = await client.query(
        `INSERT INTO drp_periods (id, drp_run_id, period_start, period_end, sequence)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [uuidv4(), runId, period.periodStart, period.periodEnd, period.sequence],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listDrpPeriods(runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_periods WHERE drp_run_id = $1 ORDER BY sequence ASC`,
    [runId],
  );
  return rows;
}

export async function createDrpItemPolicies(runId: string, data: DrpItemPoliciesInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const inserted: any[] = [];
    for (const policy of data.policies) {
      const res = await client.query(
        `INSERT INTO drp_item_policies
         (id, drp_run_id, to_node_id, preferred_from_node_id, item_id, uom, safety_stock_qty, lot_sizing_method, foq_qty, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          uuidv4(),
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

export async function listDrpItemPolicies(runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_item_policies WHERE drp_run_id = $1 ORDER BY created_at DESC`,
    [runId],
  );
  return rows;
}

export async function createDrpGrossRequirements(runId: string, data: DrpGrossRequirementsInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM drp_runs WHERE id = $1', [runId]);
    if (run.rowCount === 0) {
      const err: any = new Error('DRP_RUN_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const rows: any[] = [];
    for (const req of data.requirements) {
      const res = await client.query(
        `INSERT INTO drp_gross_requirements
         (id, drp_run_id, to_node_id, item_id, uom, period_start, source_type, source_ref, quantity, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          uuidv4(),
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

export async function listDrpGrossRequirements(runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_gross_requirements WHERE drp_run_id = $1 ORDER BY period_start ASC, created_at DESC`,
    [runId],
  );
  return rows;
}

export async function listDrpPlanLines(runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_plan_lines WHERE drp_run_id = $1 ORDER BY period_start ASC`,
    [runId],
  );
  return rows;
}

export async function listDrpPlannedTransfers(runId: string) {
  const { rows } = await query(
    `SELECT * FROM drp_planned_transfers WHERE drp_run_id = $1 ORDER BY release_date ASC`,
    [runId],
  );
  return rows;
}
