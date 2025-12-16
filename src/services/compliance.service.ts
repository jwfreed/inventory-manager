import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import type {
  lotSchema,
  movementLotAllocationsSchema,
  recallActionSchema,
  recallCaseSchema,
  recallCaseStatusPatchSchema,
  recallCaseTargetSchema,
  recallCommunicationSchema,
  recallImpactedLotSchema,
  recallImpactedShipmentSchema,
  recallTraceRunSchema,
} from '../schemas/compliance.schema';

export type LotInput = z.infer<typeof lotSchema>;
export type MovementLotAllocationsInput = z.infer<typeof movementLotAllocationsSchema>;
export type RecallCaseInput = z.infer<typeof recallCaseSchema>;
export type RecallCaseStatusPatchInput = z.infer<typeof recallCaseStatusPatchSchema>;
export type RecallCaseTargetInput = z.infer<typeof recallCaseTargetSchema>;
export type RecallTraceRunInput = z.infer<typeof recallTraceRunSchema>;
export type RecallImpactedShipmentInput = z.infer<typeof recallImpactedShipmentSchema>;
export type RecallImpactedLotInput = z.infer<typeof recallImpactedLotSchema>;
export type RecallActionInput = z.infer<typeof recallActionSchema>;
export type RecallCommunicationInput = z.infer<typeof recallCommunicationSchema>;

export function mapLot(row: any) {
  return {
    id: row.id,
    itemId: row.item_id,
    lotCode: row.lot_code,
    status: row.status,
    manufacturedAt: row.manufactured_at,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    vendorLotCode: row.vendor_lot_code,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createLot(data: LotInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'active';
  const res = await query(
    `INSERT INTO lots (id, item_id, lot_code, status, manufactured_at, received_at, expires_at, vendor_lot_code, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING *`,
    [
      id,
      data.itemId,
      data.lotCode,
      status,
      data.manufacturedAt ?? null,
      data.receivedAt ?? null,
      data.expiresAt ?? null,
      data.vendorLotCode ?? null,
      data.notes ?? null,
      now,
    ],
  );
  return mapLot(res.rows[0]);
}

export async function listLots(filters: { itemId?: string; lotCode?: string; status?: string }, limit: number, offset: number) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.itemId) {
    params.push(filters.itemId);
    conditions.push(`item_id = $${params.length}`);
  }
  if (filters.lotCode) {
    params.push(`%${filters.lotCode}%`);
    conditions.push(`lot_code ILIKE $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM lots ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(mapLot);
}

export async function getLot(id: string) {
  const res = await query('SELECT * FROM lots WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapLot(res.rows[0]);
}

export async function createMovementLotAllocations(lineId: string, data: MovementLotAllocationsInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const line = await client.query('SELECT 1 FROM inventory_movement_lines WHERE id = $1', [lineId]);
    if (line.rowCount === 0) {
      const err: any = new Error('MOVEMENT_LINE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const inserted: any[] = [];
    for (const alloc of data.allocations) {
      const res = await client.query(
        `INSERT INTO inventory_movement_lots (id, inventory_movement_line_id, lot_id, uom, quantity_delta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [uuidv4(), lineId, alloc.lotId, alloc.uom, alloc.quantityDelta, now],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listMovementLotAllocations(lineId: string) {
  const { rows } = await query(
    `SELECT * FROM inventory_movement_lots WHERE inventory_movement_line_id = $1 ORDER BY created_at ASC`,
    [lineId],
  );
  return rows;
}

export async function listMovementLotsByMovement(movementId: string) {
  const { rows } = await query(
    `SELECT iml.*
     FROM inventory_movement_lots iml
     JOIN inventory_movement_lines l ON l.id = iml.inventory_movement_line_id
     WHERE l.inventory_movement_id = $1
     ORDER BY iml.created_at ASC`,
    [movementId],
  );
  return rows;
}

export function mapRecallCase(row: any) {
  return {
    id: row.id,
    recallNumber: row.recall_number,
    status: row.status,
    severity: row.severity,
    initiatedAt: row.initiated_at,
    closedAt: row.closed_at,
    summary: row.summary,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRecallCase(data: RecallCaseInput) {
  const id = uuidv4();
  const now = new Date();
  const status = data.status ?? 'draft';
  const res = await query(
    `INSERT INTO recall_cases (id, recall_number, status, severity, initiated_at, closed_at, summary, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     RETURNING *`,
    [
      id,
      data.recallNumber,
      status,
      data.severity ?? null,
      data.initiatedAt ?? null,
      data.closedAt ?? null,
      data.summary ?? null,
      data.notes ?? null,
      now,
    ],
  );
  return mapRecallCase(res.rows[0]);
}

export async function listRecallCases(limit: number, offset: number) {
  const { rows } = await query(
    `SELECT * FROM recall_cases ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapRecallCase);
}

export async function getRecallCase(id: string) {
  const res = await query('SELECT * FROM recall_cases WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapRecallCase(res.rows[0]);
}

export async function updateRecallCaseStatus(id: string, data: RecallCaseStatusPatchInput) {
  const now = new Date();
  const res = await query(
    `UPDATE recall_cases SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
    [data.status, now, id],
  );
  if (res.rowCount === 0) return null;
  return mapRecallCase(res.rows[0]);
}

export async function createRecallTargets(caseId: string, data: RecallCaseTargetInput) {
  return withTransaction(async (client) => {
    const rc = await client.query('SELECT 1 FROM recall_cases WHERE id = $1', [caseId]);
    if (rc.rowCount === 0) {
      const err: any = new Error('RECALL_CASE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const now = new Date();
    const inserted: any[] = [];
    for (const target of data.targets) {
      if (target.targetType === 'lot' && !target.lotId) {
        const err: any = new Error('BAD_TARGET');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      if (target.targetType === 'item' && !target.itemId) {
        const err: any = new Error('BAD_TARGET');
        err.code = 'BAD_REQUEST';
        throw err;
      }
      const res = await client.query(
        `INSERT INTO recall_case_targets (id, recall_case_id, target_type, lot_id, item_id, uom, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          uuidv4(),
          caseId,
          target.targetType,
          target.lotId ?? null,
          target.itemId ?? null,
          target.uom ?? null,
          now,
        ],
      );
      inserted.push(res.rows[0]);
    }
    return inserted;
  });
}

export async function listRecallTargets(caseId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_case_targets WHERE recall_case_id = $1 ORDER BY created_at ASC`,
    [caseId],
  );
  return rows;
}

export function mapTraceRun(row: any) {
  return {
    id: row.id,
    recallCaseId: row.recall_case_id,
    asOf: row.as_of,
    status: row.status,
    notes: row.notes,
    computedAt: row.computed_at,
  };
}

export async function createRecallTraceRun(caseId: string, data: RecallTraceRunInput) {
  const resCase = await query('SELECT 1 FROM recall_cases WHERE id = $1', [caseId]);
  if (resCase.rowCount === 0) {
    const err: any = new Error('RECALL_CASE_NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const id = uuidv4();
  const status = data.status ?? 'computed';
  const res = await query(
    `INSERT INTO recall_trace_runs (id, recall_case_id, as_of, status, notes)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [id, caseId, data.asOf, status, data.notes ?? null],
  );
  return mapTraceRun(res.rows[0]);
}

export async function listRecallTraceRuns(caseId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_trace_runs WHERE recall_case_id = $1 ORDER BY computed_at DESC`,
    [caseId],
  );
  return rows.map(mapTraceRun);
}

export async function getRecallTraceRun(id: string) {
  const res = await query('SELECT * FROM recall_trace_runs WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return mapTraceRun(res.rows[0]);
}

export async function createRecallImpactedShipments(traceRunId: string, data: RecallImpactedShipmentInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM recall_trace_runs WHERE id = $1', [traceRunId]);
    if (run.rowCount === 0) {
      const err: any = new Error('TRACE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const s of data.shipments) {
      const res = await client.query(
        `INSERT INTO recall_impacted_shipments (id, recall_trace_run_id, sales_order_shipment_id, customer_id, created_at)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [uuidv4(), traceRunId, s.salesOrderShipmentId, s.customerId, now],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listRecallImpactedShipments(traceRunId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_impacted_shipments WHERE recall_trace_run_id = $1 ORDER BY created_at DESC`,
    [traceRunId],
  );
  return rows;
}

export async function createRecallImpactedLots(traceRunId: string, data: RecallImpactedLotInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const run = await client.query('SELECT 1 FROM recall_trace_runs WHERE id = $1', [traceRunId]);
    if (run.rowCount === 0) {
      const err: any = new Error('TRACE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const l of data.lots) {
      const res = await client.query(
        `INSERT INTO recall_impacted_lots (id, recall_trace_run_id, lot_id, role, created_at)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [uuidv4(), traceRunId, l.lotId, l.role, now],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listRecallImpactedLots(traceRunId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_impacted_lots WHERE recall_trace_run_id = $1 ORDER BY created_at DESC`,
    [traceRunId],
  );
  return rows;
}

export async function createRecallActions(caseId: string, data: RecallActionInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const rc = await client.query('SELECT 1 FROM recall_cases WHERE id = $1', [caseId]);
    if (rc.rowCount === 0) {
      const err: any = new Error('RECALL_CASE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const action of data.actions) {
      const status = action.status ?? 'planned';
      const res = await client.query(
        `INSERT INTO recall_actions (id, recall_case_id, action_type, status, lot_id, sales_order_shipment_id, inventory_movement_id, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         RETURNING *`,
        [
          uuidv4(),
          caseId,
          action.actionType,
          status,
          action.lotId ?? null,
          action.salesOrderShipmentId ?? null,
          action.inventoryMovementId ?? null,
          action.notes ?? null,
          now,
        ],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listRecallActions(caseId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_actions WHERE recall_case_id = $1 ORDER BY created_at DESC`,
    [caseId],
  );
  return rows;
}

export async function createRecallCommunications(caseId: string, data: RecallCommunicationInput) {
  const now = new Date();
  return withTransaction(async (client) => {
    const rc = await client.query('SELECT 1 FROM recall_cases WHERE id = $1', [caseId]);
    if (rc.rowCount === 0) {
      const err: any = new Error('RECALL_CASE_NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const rows: any[] = [];
    for (const comm of data.communications) {
      const status = comm.status ?? 'draft';
      const res = await client.query(
        `INSERT INTO recall_communications (id, recall_case_id, customer_id, channel, status, sent_at, subject, body, external_ref, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          uuidv4(),
          caseId,
          comm.customerId ?? null,
          comm.channel,
          status,
          comm.sentAt ?? null,
          comm.subject ?? null,
          comm.body ?? null,
          comm.externalRef ?? null,
          now,
        ],
      );
      rows.push(res.rows[0]);
    }
    return rows;
  });
}

export async function listRecallCommunications(caseId: string) {
  const { rows } = await query(
    `SELECT * FROM recall_communications WHERE recall_case_id = $1 ORDER BY created_at DESC`,
    [caseId],
  );
  return rows;
}
