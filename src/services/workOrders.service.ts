import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { workOrderCreateSchema, workOrderListQuerySchema } from '../schemas/workOrders.schema';
import { roundQuantity } from '../lib/numbers';
import { normalizeQuantityByUom } from '../lib/uom';
import { fetchBomById, resolveEffectiveBom, type BomVersionLine } from './boms.service';
import { getItem } from './masterData.service';
import { recordAuditLog } from '../lib/audit';

type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>;
type WorkOrderListQuery = z.infer<typeof workOrderListQuerySchema>;

type WorkOrderRow = {
  id: string;
  work_order_number: string;
  number: string | null;
  status: string;
  kind: string;
  bom_id: string | null;
  bom_version_id: string | null;
  related_work_order_id: string | null;
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
  description: string | null;
  created_at: string;
  updated_at: string;
};

function mapWorkOrder(row: WorkOrderRow) {
  return {
    id: row.id,
    number: row.number ?? row.work_order_number,
    status: row.status,
    kind: row.kind,
    bomId: row.bom_id,
    bomVersionId: row.bom_version_id,
    relatedWorkOrderId: row.related_work_order_id,
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
    description: row.description ?? row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function generateWorkOrderNumber(tenantId: string, client: PoolClient) {
  await client.query(
    `INSERT INTO work_order_sequences (tenant_id, next_number)
     VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId]
  );

  const seqResult = await client.query<{ next_number: number }>(
    'SELECT next_number FROM work_order_sequences WHERE tenant_id = $1 FOR UPDATE',
    [tenantId]
  );
  if (seqResult.rowCount === 0) {
    throw new Error('WO_SEQUENCE_MISSING');
  }
  const nextNumber = Number(seqResult.rows[0].next_number);
  const formatted = `WO-${String(nextNumber).padStart(6, '0')}`;

  await client.query(
    'UPDATE work_order_sequences SET next_number = $2 WHERE tenant_id = $1',
    [tenantId, nextNumber + 1]
  );

  return formatted;
}

export async function createWorkOrder(tenantId: string, data: WorkOrderCreateInput) {
  const now = new Date();
  const id = uuidv4();
  const status = 'draft';
  const kind = data.kind ?? 'production';
  const outputItemRes = await query<{ default_location_id: string | null; default_uom: string | null }>(
    'SELECT default_location_id, default_uom FROM items WHERE id = $1 AND tenant_id = $2',
    [data.outputItemId, tenantId]
  );
  const outputItemDefaults = outputItemRes.rows[0];
  const outputUom = data.outputUom || outputItemDefaults?.default_uom || data.outputUom;
  const defaultConsumeLocationId =
    data.defaultConsumeLocationId ?? outputItemDefaults?.default_location_id ?? null;
  const defaultProduceLocationId =
    data.defaultProduceLocationId ?? outputItemDefaults?.default_location_id ?? null;
  const normalizedQty = normalizeQuantityByUom(Number(data.quantityPlanned), outputUom);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withTransaction(async (client) => {
        if (kind === 'production' || data.bomId) {
          // Validate BOM exists and matches output item
          const bomResult = await client.query(
            'SELECT id, output_item_id FROM boms WHERE id = $1 AND tenant_id = $2',
            [data.bomId, tenantId]
          );
          if (bomResult.rowCount === 0) {
            throw new Error('WO_BOM_NOT_FOUND');
          }
          const bom = bomResult.rows[0];
          if (bom.output_item_id !== data.outputItemId) {
            throw new Error('WO_BOM_ITEM_MISMATCH');
          }

          if (data.bomVersionId) {
            const versionResult = await client.query(
              'SELECT id, bom_id FROM bom_versions WHERE id = $1 AND tenant_id = $2',
              [data.bomVersionId, tenantId]
            );
            if (versionResult.rowCount === 0) {
              throw new Error('WO_BOM_VERSION_NOT_FOUND');
            }
            if (versionResult.rows[0].bom_id !== data.bomId) {
              throw new Error('WO_BOM_VERSION_MISMATCH');
            }
          }
        }

        const number = await generateWorkOrderNumber(tenantId, client);
        const inserted = await client.query(
          `INSERT INTO work_orders (
              id, tenant_id, work_order_number, number, status, kind, bom_id, bom_version_id, related_work_order_id,
              output_item_id, output_uom,
              quantity_planned, quantity_completed, default_consume_location_id, default_produce_location_id,
              scheduled_start_at, scheduled_due_at, released_at,
              completed_at, description, created_at, updated_at
           ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11,
              $12, $13, $14, $15,
              $16, $17, NULL,
              NULL, $18, $19, $19
           ) RETURNING *`,
          [
            id,
            tenantId,
            number,
            number,
            status,
            kind,
            data.bomId ?? null,
            data.bomVersionId ?? null,
            data.relatedWorkOrderId ?? null,
            data.outputItemId,
            normalizedQty.uom,
            normalizedQty.quantity,
            data.quantityCompleted ?? null,
            defaultConsumeLocationId,
            defaultProduceLocationId,
            data.scheduledStartAt ? new Date(data.scheduledStartAt) : null,
            data.scheduledDueAt ? new Date(data.scheduledDueAt) : null,
            data.description ?? null,
            now
          ]
        );

        return mapWorkOrder(inserted.rows[0]);
      });
    } catch (error: any) {
      if (error?.code === '23505' && error?.constraint === 'idx_work_orders_tenant_number_unique' && attempt === 0) {
        continue;
      }
      throw error;
    }
  }

  throw new Error('WO_NUMBER_GENERATION_FAILED');
}

export async function getWorkOrderById(tenantId: string, id: string) {
  const result = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId
  ]);
  if (result.rowCount === 0) {
    return null;
  }
  return mapWorkOrder(result.rows[0]);
}

export async function listWorkOrders(tenantId: string, filters: WorkOrderListQuery) {
  const limit = Math.min(100, Math.max(1, Number(filters.limit ?? 20)));
  const offset = Math.max(0, Number(filters.offset ?? 0));

  const clauses: string[] = ['tenant_id = $1'];
  const params: any[] = [tenantId];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    clauses.push(`kind = $${params.length}`);
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
  usesPackSize?: boolean;
  variableUom?: string | null;
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

async function resolveRequirements(
  tenantId: string,
  components: BomVersionLine[],
  factor: number,
  packSize?: number
): Promise<WorkOrderRequirementLine[]> {
  const lines: WorkOrderRequirementLine[] = [];

  for (const c of components) {
    const item = await getItem(tenantId, c.componentItemId);
    
    if (item && item.isPhantom) {
       const phantomBom = await resolveEffectiveBom(tenantId, item.id, new Date().toISOString());
       if (phantomBom) {
          const phantomVersion = phantomBom.version;
          const normalizedComp = normalizeQuantityByUom(c.quantityPer, c.uom);
          const componentScrap = c.scrapFactor ?? 0;
          
          const baseQuantity = c.usesPackSize && packSize !== undefined ? packSize : normalizedComp.quantity;
          const requiredPhantomQty = baseQuantity * factor * (1 + componentScrap);
          
          const phantomYield = normalizeQuantityByUom(phantomVersion.yieldQuantity, phantomVersion.yieldUom);
          const phantomYieldFactor = phantomVersion.yieldFactor ?? 1.0;
          
          const childFactor = requiredPhantomQty / (phantomYield.quantity * phantomYieldFactor);
          
          const childLines = await resolveRequirements(tenantId, phantomVersion.components, childFactor, packSize);
          lines.push(...childLines);
          continue;
       }
    }

    const normalizedComp = normalizeQuantityByUom(c.quantityPer, c.uom);
    const baseQuantity = c.usesPackSize && packSize !== undefined ? packSize : normalizedComp.quantity;
    const uom = c.usesPackSize && c.variableUom ? c.variableUom : normalizedComp.uom;
    const componentScrap = c.scrapFactor ?? 0;
    const required = roundQuantity(baseQuantity * factor * (1 + componentScrap));
    
    lines.push({
      lineNumber: c.lineNumber,
      componentItemId: c.componentItemId,
      uom,
      quantityRequired: required,
      usesPackSize: c.usesPackSize,
      variableUom: c.variableUom ?? null,
      scrapFactor: c.scrapFactor
    });
  }
  return lines;
}

export async function getWorkOrderRequirements(
  tenantId: string,
  workOrderId: string,
  requestedQty?: number,
  packSize?: number
): Promise<WorkOrderRequirements | null> {
  const woRes = await query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2', [
    workOrderId,
    tenantId
  ]);
  if (woRes.rowCount === 0) return null;
  const wo = woRes.rows[0];
  if (!wo.bom_id) {
    throw new Error('WO_BOM_NOT_FOUND');
  }

  const bom = await fetchBomById(tenantId, wo.bom_id);
  if (!bom) {
    throw new Error('WO_BOM_NOT_FOUND');
  }
  const requestedVersion = wo.bom_version_id
    ? bom.versions.find((v) => v.id === wo.bom_version_id)
    : null;
  const version =
    (requestedVersion && requestedVersion.status !== 'retired' ? requestedVersion : null) ||
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

  const yieldFactor = version.yieldFactor ?? 1.0;
  const factor = roundQuantity(normalizedRequested.quantity / (normalizedYield.quantity * yieldFactor));

  const lines = await resolveRequirements(tenantId, version.components, factor, packSize);

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

export async function updateWorkOrderDefaults(
  tenantId: string,
  workOrderId: string,
  defaults: { defaultConsumeLocationId?: string | null; defaultProduceLocationId?: string | null }
) {
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

  const sql = `UPDATE work_orders SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $${params.length + 1}`;
  params.push(tenantId);
  await query(sql, params);
  return getWorkOrderById(tenantId, workOrderId);
}

export async function updateWorkOrderDescription(
  tenantId: string,
  workOrderId: string,
  description: string | null
) {
  const now = new Date();
  await query(
    `UPDATE work_orders
        SET description = $1,
            updated_at = $2
      WHERE id = $3 AND tenant_id = $4`,
    [description, now, workOrderId, tenantId]
  );
  return getWorkOrderById(tenantId, workOrderId);
}

export async function useActiveBomVersion(
  tenantId: string,
  workOrderId: string,
  actor?: { type: 'user' | 'system'; id?: string | null }
) {
  await withTransaction(async (client) => {
    const now = new Date();
    const workOrderRes = await client.query<WorkOrderRow>(
      'SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [workOrderId, tenantId]
    );
    if (workOrderRes.rowCount === 0) {
      throw new Error('WO_NOT_FOUND');
    }
    const workOrder = workOrderRes.rows[0];
    if (workOrder.kind === 'disassembly') {
      throw new Error('WO_BOM_UNSUPPORTED');
    }

    let activeMatch: Awaited<ReturnType<typeof resolveEffectiveBom>>;
    try {
      activeMatch = await resolveEffectiveBom(tenantId, workOrder.output_item_id, now.toISOString());
    } catch {
      activeMatch = null;
    }
    if (!activeMatch) {
      throw new Error('WO_BOM_VERSION_NOT_FOUND');
    }

    const versionRes = await client.query<{ id: string; bom_id: string; yield_uom: string }>(
      `SELECT id, bom_id, yield_uom
         FROM bom_versions
        WHERE id = $1 AND tenant_id = $2`,
      [activeMatch.version.id, tenantId]
    );
    if (versionRes.rowCount === 0) {
      throw new Error('WO_BOM_VERSION_NOT_FOUND');
    }
    const versionRow = versionRes.rows[0];
    if (versionRow.yield_uom && versionRow.yield_uom !== workOrder.output_uom) {
      throw new Error('WO_BOM_UOM_MISMATCH');
    }

    if (workOrder.bom_version_id !== versionRow.id || workOrder.bom_id !== versionRow.bom_id) {
      await client.query(
        `UPDATE work_orders
            SET bom_id = $1,
                bom_version_id = $2,
                updated_at = $3
          WHERE id = $4 AND tenant_id = $5`,
        [versionRow.bom_id, versionRow.id, now, workOrderId, tenantId]
      );
    }

    if (actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'update',
          entityType: 'work_order',
          entityId: workOrderId,
          occurredAt: now,
          metadata: {
            field: 'bom_version_id',
            previous: workOrder.bom_version_id ?? null,
            next: versionRow.id,
            bomId: versionRow.bom_id,
            previousBomId: workOrder.bom_id ?? null
          }
        },
        client
      );
    }
  });

  return getWorkOrderById(tenantId, workOrderId);
}
