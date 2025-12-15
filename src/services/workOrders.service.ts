import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import { query, withTransaction } from '../db';
import { workOrderCreateSchema, workOrderListQuerySchema } from '../schemas/workOrders.schema';
import { roundQuantity } from '../lib/numbers';

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
          quantity_planned, quantity_completed, scheduled_start_at, scheduled_due_at, released_at,
          completed_at, notes, created_at, updated_at
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, NULL,
          NULL, $12, $13, $13
       ) RETURNING *`,
      [
        id,
        data.workOrderNumber,
        status,
        data.bomId,
        data.bomVersionId ?? null,
        data.outputItemId,
        data.outputUom,
        data.quantityPlanned,
        data.quantityCompleted ?? null,
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
