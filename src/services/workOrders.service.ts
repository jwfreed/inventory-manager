import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { workOrderCreateSchema, workOrderListQuerySchema } from '../schemas/workOrders.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { fetchBomById, resolveEffectiveBom, type BomVersionLine } from './boms.service';
import { getItem } from './masterData.service';
import { recordAuditLog } from '../lib/audit';
import { convertToCanonical } from './uomCanonical.service';
import { expandBomWithCycleGuard, getCanonicalYieldQuantity } from './bomTraversal.service';
import { getEffectiveBomLinesForParent } from './bomEdges.service';
import { normalizeDateInputToIso } from '../core/dateAdapter';
import {
  assertWorkOrderStatusTransition,
  isEditableWorkOrderStatus,
  normalizeWorkOrderStatus
} from './workOrderLifecycle.service';
import { deriveWorkOrderStageRouting } from './stageRouting.service';
import { ensureWorkOrderReservationsReady, releaseWorkOrderReservations } from './inventoryReservation.service';
import { closeWorkOrder } from './workOrderClose.service';

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
  routing_id: string | null;
  produce_to_location_id_snapshot: string | null;
  related_work_order_id: string | null;
  output_item_id: string;
  output_uom: string;
  quantity_planned: string | number;
  quantity_completed: string | number | null;
  quantity_scrapped: string | number | null;
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
    status: normalizeWorkOrderStatus(row.status),
    kind: row.kind,
    bomId: row.bom_id,
    bomVersionId: row.bom_version_id,
    routingId: row.routing_id,
    produceToLocationIdSnapshot: row.produce_to_location_id_snapshot,
    relatedWorkOrderId: row.related_work_order_id,
    outputItemId: row.output_item_id,
    outputUom: row.output_uom,
    quantityPlanned: roundQuantity(Number(row.quantity_planned)),
    quantityCompleted: row.quantity_completed !== null ? roundQuantity(Number(row.quantity_completed)) : null,
    quantityScrapped: row.quantity_scrapped !== null ? roundQuantity(Number(row.quantity_scrapped)) : null,
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

type WorkOrderMapped = ReturnType<typeof mapWorkOrder>;

type LocationHint = {
  id: string;
  code: string;
  name: string;
};

async function resolveDefaultRoutingId(
  tenantId: string,
  outputItemId: string,
  client: PoolClient
): Promise<string | null> {
  const routingRes = await client.query<{ id: string }>(
    `SELECT id
       FROM routings
      WHERE tenant_id = $1
        AND item_id = $2
      ORDER BY
        CASE WHEN is_default THEN 0 ELSE 1 END,
        CASE
          WHEN status = 'active' THEN 0
          WHEN status = 'draft' THEN 1
          ELSE 2
        END,
        updated_at DESC,
        created_at DESC,
        id
      LIMIT 1`,
    [tenantId, outputItemId]
  );
  return routingRes.rows[0]?.id ?? null;
}

async function resolveRoutingFinalStepLocationHint(
  tenantId: string,
  routingId: string,
  client?: PoolClient
): Promise<LocationHint | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<LocationHint>(
    `SELECT l.id, l.code, l.name
       FROM routing_steps rs
       JOIN work_centers wc
         ON wc.id = rs.work_center_id
        AND wc.tenant_id = $1
       JOIN locations l
         ON l.id = wc.location_id
        AND l.tenant_id = $1
      WHERE rs.tenant_id = $1
        AND rs.routing_id = $2
      ORDER BY rs.sequence_number DESC
      LIMIT 1`,
    [tenantId, routingId]
  );
  return res.rows[0] ?? null;
}

async function resolveLocationHintById(
  tenantId: string,
  locationId: string,
  client?: PoolClient
): Promise<LocationHint | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<LocationHint>(
    `SELECT id, code, name
       FROM locations
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId]
  );
  return res.rows[0] ?? null;
}

async function withReportProductionLocationHint(
  tenantId: string,
  workOrder: WorkOrderMapped,
  client?: PoolClient
) {
  const routing = await deriveWorkOrderStageRouting(
    tenantId,
    {
      kind: workOrder.kind,
      outputItemId: workOrder.outputItemId,
      bomId: workOrder.bomId,
      defaultConsumeLocationId: workOrder.defaultConsumeLocationId,
      defaultProduceLocationId: workOrder.defaultProduceLocationId,
      produceToLocationIdSnapshot: workOrder.produceToLocationIdSnapshot
    },
    client
  );

  if (workOrder.produceToLocationIdSnapshot) {
    const snapshotLocation = await resolveLocationHintById(tenantId, workOrder.produceToLocationIdSnapshot, client);
    if (snapshotLocation) {
      return {
        ...workOrder,
        stageType: routing.stageType,
        stageLabel: routing.stageLabel,
        routingLocked: routing.routingLocked,
        derivedConsumeLocationId: routing.defaultConsumeLocation?.id ?? null,
        derivedConsumeLocationCode: routing.defaultConsumeLocation?.code ?? null,
        derivedConsumeLocationName: routing.defaultConsumeLocation?.name ?? null,
        derivedProduceLocationId: routing.defaultProduceLocation?.id ?? null,
        derivedProduceLocationCode: routing.defaultProduceLocation?.code ?? null,
        derivedProduceLocationName: routing.defaultProduceLocation?.name ?? null,
        reportProductionReceiveToLocationId: snapshotLocation.id,
        reportProductionReceiveToLocationCode: snapshotLocation.code,
        reportProductionReceiveToLocationName: snapshotLocation.name,
        reportProductionReceiveToSource: 'routing_snapshot'
      };
    }
  }

  if (workOrder.routingId) {
    const snapshotLocation = await resolveRoutingFinalStepLocationHint(tenantId, workOrder.routingId, client);
    if (snapshotLocation) {
      return {
        ...workOrder,
        stageType: routing.stageType,
        stageLabel: routing.stageLabel,
        routingLocked: routing.routingLocked,
        derivedConsumeLocationId: routing.defaultConsumeLocation?.id ?? null,
        derivedConsumeLocationCode: routing.defaultConsumeLocation?.code ?? null,
        derivedConsumeLocationName: routing.defaultConsumeLocation?.name ?? null,
        derivedProduceLocationId: routing.defaultProduceLocation?.id ?? null,
        derivedProduceLocationCode: routing.defaultProduceLocation?.code ?? null,
        derivedProduceLocationName: routing.defaultProduceLocation?.name ?? null,
        reportProductionReceiveToLocationId: snapshotLocation.id,
        reportProductionReceiveToLocationCode: snapshotLocation.code,
        reportProductionReceiveToLocationName: snapshotLocation.name,
        reportProductionReceiveToSource: 'routing_snapshot'
      };
    }
  }

  if (workOrder.defaultProduceLocationId) {
    const defaultLocation = await resolveLocationHintById(tenantId, workOrder.defaultProduceLocationId, client);
    if (defaultLocation) {
      return {
        ...workOrder,
        stageType: routing.stageType,
        stageLabel: routing.stageLabel,
        routingLocked: routing.routingLocked,
        derivedConsumeLocationId: routing.defaultConsumeLocation?.id ?? null,
        derivedConsumeLocationCode: routing.defaultConsumeLocation?.code ?? null,
        derivedConsumeLocationName: routing.defaultConsumeLocation?.name ?? null,
        derivedProduceLocationId: routing.defaultProduceLocation?.id ?? null,
        derivedProduceLocationCode: routing.defaultProduceLocation?.code ?? null,
        derivedProduceLocationName: routing.defaultProduceLocation?.name ?? null,
        reportProductionReceiveToLocationId: defaultLocation.id,
        reportProductionReceiveToLocationCode: defaultLocation.code,
        reportProductionReceiveToLocationName: defaultLocation.name,
        reportProductionReceiveToSource: 'work_order_default'
      };
    }
  }

  return {
    ...workOrder,
    stageType: routing.stageType,
    stageLabel: routing.stageLabel,
    routingLocked: routing.routingLocked,
    derivedConsumeLocationId: routing.defaultConsumeLocation?.id ?? null,
    derivedConsumeLocationCode: routing.defaultConsumeLocation?.code ?? null,
    derivedConsumeLocationName: routing.defaultConsumeLocation?.name ?? null,
    derivedProduceLocationId: routing.defaultProduceLocation?.id ?? null,
    derivedProduceLocationCode: routing.defaultProduceLocation?.code ?? null,
    derivedProduceLocationName: routing.defaultProduceLocation?.name ?? null,
    reportProductionReceiveToLocationId: null,
    reportProductionReceiveToLocationCode: null,
    reportProductionReceiveToLocationName: null,
    reportProductionReceiveToSource: 'warehouse_default'
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
  const plannedQty = toNumber(data.quantityPlanned);

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
        const routingId =
          kind === 'production'
            ? await resolveDefaultRoutingId(tenantId, data.outputItemId, client)
            : null;
        const stageRouting = await deriveWorkOrderStageRouting(
          tenantId,
          {
            kind,
            outputItemId: data.outputItemId,
            bomId: data.bomId ?? null,
            defaultConsumeLocationId: data.defaultConsumeLocationId ?? outputItemDefaults?.default_location_id ?? null,
            defaultProduceLocationId: data.defaultProduceLocationId ?? outputItemDefaults?.default_location_id ?? null,
            produceToLocationIdSnapshot: null
          },
          client
        );
        const defaultConsumeLocationId =
          stageRouting.defaultConsumeLocation?.id ?? outputItemDefaults?.default_location_id ?? null;
        const defaultProduceLocationId =
          stageRouting.defaultProduceLocation?.id ?? outputItemDefaults?.default_location_id ?? null;
        const inserted = await client.query(
          `INSERT INTO work_orders (
              id, tenant_id, work_order_number, number, status, kind, bom_id, bom_version_id, related_work_order_id,
              routing_id,
              produce_to_location_id_snapshot,
              output_item_id, output_uom,
              quantity_planned, quantity_completed, default_consume_location_id, default_produce_location_id,
              scheduled_start_at, scheduled_due_at, released_at,
              completed_at, description, created_at, updated_at
           ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10,
              $11,
              $12, $13,
              $14, $15, $16, $17,
              $18, $19, NULL,
              NULL, $20, $21, $21
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
            routingId,
            stageRouting.defaultProduceLocation?.id ?? null,
            data.outputItemId,
            outputUom,
            plannedQty,
            data.quantityCompleted ?? null,
            defaultConsumeLocationId,
            defaultProduceLocationId,
            data.scheduledStartAt ? new Date(normalizeDateInputToIso(data.scheduledStartAt) ?? data.scheduledStartAt) : null,
            data.scheduledDueAt ? new Date(normalizeDateInputToIso(data.scheduledDueAt) ?? data.scheduledDueAt) : null,
            data.description ?? null,
            now
          ]
        );

        return withReportProductionLocationHint(tenantId, mapWorkOrder(inserted.rows[0]), client);
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
  const result = await query<WorkOrderRow>(
    `SELECT id, tenant_id, work_order_number, number, status, kind, bom_id, bom_version_id, routing_id, produce_to_location_id_snapshot, related_work_order_id,
            output_item_id, output_uom, quantity_planned, quantity_completed, quantity_scrapped, default_consume_location_id,
            default_produce_location_id, scheduled_start_at, scheduled_due_at, released_at, completed_at,
            notes, description, created_at, updated_at
     FROM work_orders WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return withReportProductionLocationHint(tenantId, mapWorkOrder(result.rows[0]));
}

export async function listWorkOrders(tenantId: string, filters: WorkOrderListQuery) {
  const limit = Math.min(100, Math.max(1, Number(filters.limit ?? 20)));
  const offset = Math.max(0, Number(filters.offset ?? 0));

  const clauses: string[] = ['tenant_id = $1'];
  const params: any[] = [tenantId];

  if (filters.status) {
    params.push(normalizeWorkOrderStatus(filters.status));
    clauses.push(`status = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (filters.plannedFrom) {
    params.push(new Date(normalizeDateInputToIso(filters.plannedFrom) ?? filters.plannedFrom));
    clauses.push(`scheduled_start_at >= $${params.length}`);
  }
  if (filters.plannedTo) {
    params.push(new Date(normalizeDateInputToIso(filters.plannedTo) ?? filters.plannedTo));
    clauses.push(`scheduled_due_at <= $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query<WorkOrderRow>(
    `SELECT id, tenant_id, work_order_number, number, status, kind, bom_id, bom_version_id, routing_id, produce_to_location_id_snapshot, related_work_order_id,
            output_item_id, output_uom, quantity_planned, quantity_completed, quantity_scrapped, default_consume_location_id,
            default_produce_location_id, scheduled_start_at, scheduled_due_at, released_at, completed_at,
            notes, description, created_at, updated_at
     FROM work_orders ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
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

type RequirementExpansionComponent = Pick<
  BomVersionLine,
  | 'id'
  | 'lineNumber'
  | 'componentItemId'
  | 'quantityPer'
  | 'uom'
  | 'quantityPerCanonical'
  | 'uomCanonical'
  | 'uomDimension'
  | 'scrapFactor'
  | 'usesPackSize'
  | 'variableUom'
  | 'notes'
> & {
  componentIsPhantom?: boolean;
};

async function resolveRequirements(
  tenantId: string,
  rootItemId: string,
  components: RequirementExpansionComponent[],
  factor: number,
  packSize: number | undefined,
  asOfIso: string
): Promise<WorkOrderRequirementLine[]> {
  const lines: WorkOrderRequirementLine[] = [];
  const readOnlyQuery = { query };
  const itemCache = new Map<string, Awaited<ReturnType<typeof getItem>>>();
  const phantomBomCache = new Map<string, Awaited<ReturnType<typeof getEffectiveBomLinesForParent>>>();
  const phantomYieldCache = new Map<string, number>();

  const getItemCached = async (itemId: string) => {
    if (!itemCache.has(itemId)) {
      itemCache.set(itemId, await getItem(tenantId, itemId));
    }
    return itemCache.get(itemId) ?? null;
  };

  const getPhantomBomCached = async (itemId: string) => {
    if (!phantomBomCache.has(itemId)) {
      phantomBomCache.set(itemId, await getEffectiveBomLinesForParent(readOnlyQuery, tenantId, itemId, asOfIso));
    }
    return phantomBomCache.get(itemId) ?? null;
  };

  const getPhantomYieldCached = async (
    itemId: string,
    phantomBom: NonNullable<Awaited<ReturnType<typeof getEffectiveBomLinesForParent>>>
  ) => {
    if (!phantomYieldCache.has(itemId)) {
      const canonicalYield = await getCanonicalYieldQuantity(
        tenantId,
        phantomBom,
        convertToCanonical,
        itemId
      );
      phantomYieldCache.set(itemId, canonicalYield);
    }
    return phantomYieldCache.get(itemId)!;
  };

  await expandBomWithCycleGuard<{ factor: number }, RequirementExpansionComponent>({
    root: {
      itemId: rootItemId,
      components,
      state: { factor }
    },
    onComponent: async ({ node, component, descend }) => {
      if (component.quantityPerCanonical == null || !component.uomCanonical) {
        throw new Error('WO_BOM_LEGACY_UNSUPPORTED');
      }
      const item = await getItemCached(component.componentItemId);
      const isPhantom = typeof component.componentIsPhantom === 'boolean'
        ? component.componentIsPhantom
        : !!item?.isPhantom;
      const componentScrap = component.scrapFactor ?? 0;
      const baseQuantity = component.usesPackSize && packSize !== undefined
        ? (await convertToCanonical(tenantId, component.componentItemId, packSize, component.uom)).quantity
        : component.quantityPerCanonical;
      const required = baseQuantity * node.state.factor * (1 + componentScrap);

      if (isPhantom) {
        const phantomItemId = component.componentItemId;
        const phantomBom = await getPhantomBomCached(phantomItemId);
        if (phantomBom) {
          const phantomYield = await getPhantomYieldCached(phantomItemId, phantomBom);
          const childFactor = required / phantomYield;
          await descend({
            itemId: phantomItemId,
            components: phantomBom.components,
            state: { factor: childFactor }
          });
          return;
        }
      }

      lines.push({
        lineNumber: component.lineNumber,
        componentItemId: component.componentItemId,
        uom: component.uomCanonical,
        quantityRequired: required,
        usesPackSize: component.usesPackSize,
        variableUom: component.variableUom ?? null,
        scrapFactor: component.scrapFactor
      });
    }
  });

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

  const quantity = requestedQty !== undefined ? requestedQty : Number(wo.quantity_planned);
  const normalizedYield = await convertToCanonical(
    tenantId,
    wo.output_item_id,
    toNumber(version.yieldQuantity),
    version.yieldUom
  );
  const normalizedRequested = await convertToCanonical(
    tenantId,
    wo.output_item_id,
    quantity,
    wo.output_uom
  );

  if (normalizedYield.canonicalUom !== normalizedRequested.canonicalUom) {
    throw new Error('WO_REQUIREMENTS_UOM_MISMATCH');
  }
  if (normalizedYield.quantity <= 0) {
    throw new Error('WO_REQUIREMENTS_INVALID_YIELD');
  }

  const yieldFactor = version.yieldFactor ?? 1.0;
  const factor = normalizedRequested.quantity / (normalizedYield.quantity * yieldFactor);

  const asOfIso = new Date().toISOString();
  const lines = await resolveRequirements(
    tenantId,
    wo.output_item_id,
    version.components as RequirementExpansionComponent[],
    factor,
    packSize,
    asOfIso
  );

  return {
    workOrderId: wo.id,
    outputItemId: wo.output_item_id,
    bomId: wo.bom_id,
    bomVersionId: version.id,
    quantityRequested: normalizedRequested.quantity,
    requestedUom: normalizedRequested.canonicalUom,
    lines
  };
}

export async function updateWorkOrderDefaults(
  tenantId: string,
  workOrderId: string,
  defaults: { defaultConsumeLocationId?: string | null; defaultProduceLocationId?: string | null }
) {
  const workOrder = await getWorkOrderById(tenantId, workOrderId);
  if (!workOrder) return null;
  if (!isEditableWorkOrderStatus(workOrder.status)) {
    throw new Error('WO_ROUTING_LOCKED');
  }
  throw new Error('WO_ROUTING_LOCKED');
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

export async function transitionWorkOrderStatus(
  tenantId: string,
  workOrderId: string,
  nextStatus: 'ready' | 'closed' | 'canceled'
) {
  const current = await getWorkOrderById(tenantId, workOrderId);
  if (!current) {
    throw new Error('WO_NOT_FOUND');
  }
  assertWorkOrderStatusTransition(current.status, nextStatus);
  if (nextStatus === 'ready') {
    await ensureWorkOrderReservationsReady(tenantId, workOrderId);
    const now = new Date();
    await query(
      `UPDATE work_orders
          SET status = 'ready',
              released_at = COALESCE(released_at, $1),
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3`,
      [now, workOrderId, tenantId]
    );
    return getWorkOrderById(tenantId, workOrderId);
  }
  if (nextStatus === 'closed') {
    await closeWorkOrder(tenantId, workOrderId);
    return getWorkOrderById(tenantId, workOrderId);
  }

  const now = new Date();
  await withTransaction(async (client) => {
    await releaseWorkOrderReservations(tenantId, workOrderId, 'work_order_canceled', client);
    await client.query(
      `UPDATE work_orders
          SET status = 'canceled',
              updated_at = $1
        WHERE id = $2
          AND tenant_id = $3`,
      [now, workOrderId, tenantId]
    );
  });
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
