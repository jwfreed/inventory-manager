import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { workOrderCreateSchema, workOrderListQuerySchema } from '../schemas/workOrders.schema';
import { roundQuantity } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';
import { fetchBomById } from './boms.service';

type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>;
type WorkOrderListQuery = z.infer<typeof workOrderListQuerySchema>;

type WorkOrderRow = {
  id: string;
  work_order_number: string;
  status: string;
  bom_id: string;
  bom_version_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  default_consume_location_id: string | null;
  default_produce_location_id: string | null;
  scheduled_start_at: string | null;
  scheduled_due_at: string | null;
  released_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function mapWorkOrder(row: WorkOrderRow) {
  return {
    id: row.id,
    workOrderNumber: row.work_order_number,
    status: row.status,
    bomId: row.bom_id,
    bomVersionId: row.bom_version_id,
    outputItemId: row.output_item_id,
    outputUom: row.output_uom,
    quantityPlanned: roundQuantity(Number(row.quantity_planned)),
    quantityCompleted: row.quantity_completed !== null ? roundQuantity(Number(row.quantity_completed)) : null,
    defaultConsumeLocationId: row.default_consume_location_id,
    defaultProduceLocationId: row.default_produce_location_id,
    scheduledStartAt: row.scheduled_start_at,
    scheduledDueAt: row.scheduled_due_at,
    releasedAt: row.released_at,
    completedAt: row.completed_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createWorkOrder(data: WorkOrderCreateInput) {
  const now = new Date();
  const id = uuidv4();
  const status = 'draft';
  const normalizedQty = normalizeQuantityByUom(Number(data.quantityPlanned), data.outputUom);

  return withTransaction(async (client) => {
    // Validate BOM exists and matches output item
    const bomResult = await client.query('SELECT id, output_item_id FROM boms WHERE id = $1', [data.bomId]);
    if (bomResult.rowCount === 0) {
      throw new Error('WO_BOM_NOT_FOUND');
    }
    const bom = bomResult.rows[0];
    if (bom.output_item_id !== data.outputItemId) {
      throw new Error('WO_BOM_ITEM_MISMATCH');
    }

    if (data.bomVersionId) {
      const versionResult = await client.query('SELECT id, bom_id FROM bom_versions WHERE id = $1', [data.bomVersionId]);
      if (versionResult.rowCount === 0) {
        throw new Error('WO_BOM_VERSION_NOT_FOUND');
      }
      if (versionResult.rows[0].bom_id !== data.bomId) {
        throw new Error('WO_BOM_VERSION_MISMATCH');
      }
    }

    const inserted = await client.query(
      `INSERT INTO work_orders (
          id, work_order_number, status, bom_id, bom_version_id, output_item_id, output_uom,
          quantity_planned, quantity_completed, default_consume_location_id, default_produce_location_id,
          scheduled_start_at, scheduled_due_at, released_at,
          completed_at, notes, created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11,
          $12, $13, NULL,
          NULL, $14, $15, $15
       ) RETURNING *`,
      [
        id,
        data.workOrderNumber,
        status,
        data.bomId,
        data.bomVersionId ?? null,
        data.outputItemId,
        normalizedQty.uom,
        normalizedQty.quantity,
        data.quantityCompleted ?? null,
        data.defaultConsumeLocationId ?? null,
        data.defaultProduceLocationId ?? null,
        data.scheduledStartAt ? new Date(data.scheduledStartAt) : null,
        data.scheduledDueAt ? new Date(data.scheduledDueAt) : null,
        data.notes ?? null,
        now
      ]
    );

    return mapWorkOrder(inserted.rows[0]);
  });
}

export async function getWorkOrderById(id: string) {
  const result = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    return null;
  }
  return mapWorkOrder(result.rows[0]);
}

export async function listWorkOrders(filters: WorkOrderListQuery) {
  const limit = Math.min(100, Math.max(1, Number(filters.limit ?? 20)));
  const offset = Math.max(0, Number(filters.offset ?? 0));

  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.plannedFrom) {
    params.push(new Date(filters.plannedFrom));
    clauses.push(`scheduled_start_at >= $${params.length}`);
  }
  if (filters.plannedTo) {
    params.push(new Date(filters.plannedTo));
    clauses.push(`scheduled_due_at <= $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query<WorkOrderRow>(
    `SELECT * FROM work_orders ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { data: rows.map(mapWorkOrder), paging: { limit, offset } };
}

export type WorkOrderRequirementLine = {
  lineNumber: number;
  componentItemId: string;
  uom: string;
  quantityRequired: number;
  scrapFactor: number | null;
};

export type WorkOrderRequirements = {
  workOrderId: string;
  outputItemId: string;
  bomId: string;
  bomVersionId: string;
  quantityRequested: number;
  requestedUom: string;
  lines: WorkOrderRequirementLine[];
};

export async function getWorkOrderRequirements(workOrderId: string, requestedQty?: number): Promise<WorkOrderRequirements | null> {
  const woRes = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1', [workOrderId]);
  if (woRes.rowCount === 0) return null;
  const wo = woRes.rows[0];

  const bom = await fetchBomById(wo.bom_id);
  if (!bom) {
    throw new Error('WO_BOM_NOT_FOUND');
  }
  const version =
    (wo.bom_version_id && bom.versions.find((v) => v.id === wo.bom_version_id)) ||
    bom.versions.find((v) => v.status === 'active') ||
    bom.versions[0];
  if (!version) {
    throw new Error('WO_BOM_VERSION_NOT_FOUND');
  }

  const normalizedYield = normalizeQuantityByUom(version.yieldQuantity, version.yieldUom);
  const quantity = requestedQty !== undefined ? requestedQty : Number(wo.quantity_planned);
  const normalizedRequested = normalizeQuantityByUom(quantity, wo.output_uom);

  if (normalizedYield.uom !== normalizedRequested.uom) {
    throw new Error('WO_REQUIREMENTS_UOM_MISMATCH');
  }
  if (normalizedYield.quantity <= 0) {
    throw new Error('WO_REQUIREMENTS_INVALID_YIELD');
  }

  const factor = roundQuantity(normalizedRequested.quantity / normalizedYield.quantity);

  const lines: WorkOrderRequirementLine[] = version.components.map((c) => {
    const normalizedComp = normalizeQuantityByUom(c.quantityPer, c.uom);
    const scrap = c.scrapFactor ?? 0;
    const required = roundQuantity(normalizedComp.quantity * factor * (1 + scrap));
    return {
      lineNumber: c.lineNumber,
      componentItemId: c.componentItemId,
      uom: normalizedComp.uom,
      quantityRequired: required,
      scrapFactor: c.scrapFactor
    };
  });

  return {
    workOrderId: wo.id,
    outputItemId: wo.output_item_id,
    bomId: wo.bom_id,
    bomVersionId: version.id,
    quantityRequested: normalizedRequested.quantity,
    requestedUom: normalizedRequested.uom,
    lines
  };
}

export async function updateWorkOrderDefaults(workOrderId: string, defaults: { defaultConsumeLocationId?: string | null; defaultProduceLocationId?: string | null }) {
  const now = new Date();
  const sets: string[] = [];
  const params: any[] = [];

  if ('defaultConsumeLocationId' in defaults) {
    params.push(defaults.defaultConsumeLocationId);
    sets.push(`default_consume_location_id = $${params.length}`);
  }
  if ('defaultProduceLocationId' in defaults) {
    params.push(defaults.defaultProduceLocationId);
    sets.push(`default_produce_location_id = $${params.length}`);
  }
  params.push(now);
  const updatedAtIdx = params.length;
  sets.push(`updated_at = $${updatedAtIdx}`);
  params.unshift(workOrderId);

  const sql = `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $1`;
  await query(sql, params);
  return getWorkOrderById(workOrderId);
}
