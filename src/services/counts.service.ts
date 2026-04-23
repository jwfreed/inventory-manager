import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { getInventoryReconciliationPolicy } from '../config/inventoryPolicy';
import { pool, withTransaction } from '../db';
import { inventoryCountSchema, inventoryCountUpdateSchema } from '../schemas/counts.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { IDEMPOTENCY_ENDPOINTS } from '../lib/idempotencyEndpoints';
import { validateSufficientStock } from './stockValidation.service';
import {
  applyPlannedCostLayerConsumption,
  createCostLayer,
  planCostLayerConsumption
} from './costLayers.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  persistInventoryMovement
} from '../domains/inventory';
import {
  runInventoryCommand,
  type InventoryCommandEvent,
  type InventoryCommandProjectionOp
} from '../modules/platform/application/runInventoryCommand';
import {
  buildPostedDocumentReplayResult,
  buildInventoryBalanceProjectionOp,
  buildMovementPostedEvent,
  buildRefreshItemCostSummaryProjectionOp,
  sortDeterministicMovementLines,
} from '../modules/platform/application/inventoryMutationSupport';
import { buildInventoryRegistryEvent } from '../modules/platform/application/inventoryEventRegistry';

type InventoryCountInput = z.infer<typeof inventoryCountSchema>;
type InventoryCountUpdateInput = z.infer<typeof inventoryCountUpdateSchema>;

type CycleCountRow = {
  id: string;
  warehouse_id: string;
  status: string;
  counted_at: string;
  location_id: string | null;
  notes: string | null;
  inventory_adjustment_id: string | null;
  inventory_movement_id: string | null;
  counter_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
};

type CycleCountLineRow = {
  id: string;
  cycle_count_id: string;
  line_number: number;
  item_id: string;
  location_id: string;
  uom: string;
  counted_quantity: string | number;
  unit_cost_for_positive_adjustment: string | number | null;
  system_quantity: string | number | null;
  system_qty_snapshot: string | number | null;
  variance_quantity: string | number | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
  task_status: string;
  reconciled_movement_id: string | null;
  reconciled_at: string | null;
};

type OnHandKey = string;

function makeOnHandKey(itemId: string, locationId: string, uom: string): OnHandKey {
  return `${locationId}:${itemId}:${uom}`;
}

async function loadSystemOnHandForLines(
  tenantId: string,
  occurredAt: string,
  lines: { itemId: string; locationId: string; uom: string }[],
  client?: PoolClient
): Promise<Map<OnHandKey, number>> {
  const map = new Map<OnHandKey, number>();
  if (lines.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const itemIds = Array.from(new Set(lines.map((line) => line.itemId)));
  const locationIds = Array.from(new Set(lines.map((line) => line.locationId)));
  const { rows } = await executor.query(
    `SELECT l.item_id, l.location_id, l.uom, COALESCE(SUM(l.quantity_delta), 0) AS qty
       FROM inventory_movement_lines l
       JOIN inventory_movements m ON m.id = l.movement_id
      WHERE m.status = 'posted'
        AND m.occurred_at <= $1
        AND l.item_id = ANY($2::uuid[])
        AND l.location_id = ANY($3::uuid[])
        AND l.tenant_id = $4
        AND m.tenant_id = $4
      GROUP BY l.item_id, l.location_id, l.uom`,
    [occurredAt, itemIds, locationIds, tenantId]
  );
  for (const row of rows) {
    map.set(makeOnHandKey(row.item_id, row.location_id, row.uom), toNumber(row.qty));
  }
  return map;
}

type CycleCountLineSummary = {
  id: string;
  lineNumber: number;
  itemId: string;
  locationId: string;
  uom: string;
  countedQuantity: number;
  unitCostForPositiveAdjustment: number | null;
  systemQuantity: number;
  systemQtySnapshot: number | null;
  varianceQuantity: number;
  varianceRatio: number;
  variancePct: number;
  accuracyPct: number;
  hit: boolean;
  reasonCode: string | null;
  notes: string | null;
  createdAt: string;
  taskStatus: string;
  reconciledMovementId: string | null;
  reconciledAt: string | null;
};

type CycleCountSummary = {
  totalAbsVariance: number;
  totalSystemQty: number;
  lineCount: number;
  linesWithVariance: number;
  hits: number;
  hitRate: number;
  weightedVariancePct: number;
  weightedAccuracyPct: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function mapCycleCountLines(
  countRow: CycleCountRow,
  lines: CycleCountLineRow[],
  systemMap: Map<OnHandKey, number>,
  useSnapshots: boolean
): { lineSummaries: CycleCountLineSummary[]; summary: CycleCountSummary } {
  const lineSummaries = lines.map((line) => {
    const countedQty = roundQuantity(toNumber(line.counted_quantity));
    const systemQty = useSnapshots
      ? roundQuantity(toNumber(line.system_quantity ?? 0))
      : systemMap.get(makeOnHandKey(line.item_id, line.location_id, line.uom)) ?? 0;
    const variance = useSnapshots
      ? roundQuantity(toNumber(line.variance_quantity ?? 0))
      : roundQuantity(countedQty - systemQty);
    const varianceRatio = countedQty === 0 ? Math.abs(variance) : Math.abs(variance) / countedQty;
    const absVariance = Math.abs(variance);
    const variancePct =
      systemQty > 0 ? absVariance / systemQty : countedQty === 0 ? 0 : 1;
    const accuracyPct = clamp(1 - variancePct, 0, 1);
    const hit = variance === 0;
    return {
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      locationId: line.location_id,
      uom: line.uom,
      countedQuantity: countedQty,
      unitCostForPositiveAdjustment:
        line.unit_cost_for_positive_adjustment !== null
          ? roundQuantity(toNumber(line.unit_cost_for_positive_adjustment))
          : null,
      systemQuantity: systemQty,
      systemQtySnapshot:
        line.system_qty_snapshot !== null
          ? roundQuantity(toNumber(line.system_qty_snapshot))
          : null,
      varianceQuantity: variance,
      varianceRatio: roundQuantity(varianceRatio),
      variancePct: roundQuantity(variancePct),
      accuracyPct: roundQuantity(accuracyPct),
      hit,
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at,
      taskStatus: line.task_status ?? 'pending',
      reconciledMovementId: line.reconciled_movement_id ?? null,
      reconciledAt: line.reconciled_at ?? null
    };
  });

  const totalAbsVariance = roundQuantity(
    lineSummaries.reduce((sum, line) => sum + Math.abs(line.varianceQuantity), 0)
  );
  const totalSystemQty = roundQuantity(
    lineSummaries.reduce((sum, line) => sum + line.systemQuantity, 0)
  );
  const linesWithVariance = lineSummaries.filter((line) => line.varianceQuantity !== 0).length;
  const hits = lineSummaries.filter((line) => line.hit).length;
  const hitRate = lineSummaries.length === 0 ? 0 : hits / lineSummaries.length;
  const allCountedZero = lineSummaries.every((line) => line.countedQuantity === 0);
  const weightedVariancePct =
    totalSystemQty > 0 ? totalAbsVariance / totalSystemQty : allCountedZero ? 0 : 1;
  const weightedAccuracyPct = clamp(1 - weightedVariancePct, 0, 1);

  return {
    lineSummaries,
    summary: {
      totalAbsVariance,
      totalSystemQty,
      lineCount: lineSummaries.length,
      linesWithVariance,
      hits,
      hitRate: roundQuantity(hitRate),
      weightedVariancePct: roundQuantity(weightedVariancePct),
      weightedAccuracyPct: roundQuantity(weightedAccuracyPct)
    }
  };
}

function mapCycleCount(
  row: CycleCountRow,
  lines: CycleCountLineRow[],
  systemMap: Map<OnHandKey, number>,
  useSnapshots: boolean
) {
  const { lineSummaries, summary } = mapCycleCountLines(row, lines, systemMap, useSnapshots);
  const totalLines = lineSummaries.length;
  const reconciledLines = lineSummaries.filter((l) => l.taskStatus === 'reconciled').length;
  const countedLines = lineSummaries.filter((l) => l.taskStatus === 'counted').length;
  const pendingLines = lineSummaries.filter((l) => l.taskStatus === 'pending').length;
  const completionProgress = totalLines === 0 ? 0 : roundQuantity(reconciledLines / totalLines);
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    status: row.status,
    countedAt: row.counted_at,
    locationId: row.location_id,
    inventoryAdjustmentId: row.inventory_adjustment_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    counterId: row.counter_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lineSummaries,
    summary,
    progress: { totalLines, reconciledLines, countedLines, pendingLines, completionProgress }
  };
}

async function fetchCycleCountById(tenantId: string, id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const countResult = await executor.query<CycleCountRow>(
    'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  if (countResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<CycleCountLineRow>(
    'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
    [id, tenantId]
  );
  const useSnapshots =
    linesResult.rows.length > 0 &&
    linesResult.rows.every(
      (line) => line.system_quantity !== null && line.variance_quantity !== null
    );
  const items = linesResult.rows.map((line) => ({
    itemId: line.item_id,
    locationId: line.location_id,
    uom: line.uom
  }));
  const systemMap = useSnapshots
    ? new Map<OnHandKey, number>()
    : await loadSystemOnHandForLines(
        tenantId,
        countResult.rows[0].counted_at,
        items,
        client
      );
  return mapCycleCount(countResult.rows[0], linesResult.rows, systemMap, useSnapshots);
}

function normalizeCountLines(data: InventoryCountInput) {
  const lineNumbers = new Set<number>();
  const itemUomKeys = new Set<string>();

  return data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('COUNT_DUPLICATE_LINE');
    }
    lineNumbers.add(lineNumber);
    const locationId = line.locationId ?? data.locationId;
    if (!locationId) {
      throw new Error('COUNT_LOCATION_REQUIRED');
    }
    const key = makeOnHandKey(line.itemId, locationId, line.uom);
    if (itemUomKeys.has(key)) {
      throw new Error('COUNT_DUPLICATE_ITEM');
    }
    itemUomKeys.add(key);
    return {
      lineNumber,
      itemId: line.itemId,
      locationId,
      uom: line.uom,
      countedQuantity: roundQuantity(line.countedQuantity),
      unitCostForPositiveAdjustment:
        line.unitCostForPositiveAdjustment != null
          ? roundQuantity(line.unitCostForPositiveAdjustment)
          : null,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });
}

function normalizeCycleCountPostingPayload(params: {
  countId: string;
  warehouseId: string;
  occurredAt: string;
  lines: Array<{
    itemId: string;
    locationId: string;
    uom: string;
    countedQuantity: number;
    unitCostForPositiveAdjustment: number | null;
  }>;
}) {
  const lines = [...params.lines]
    .map((line) => ({
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.uom,
      countedQuantity: roundQuantity(line.countedQuantity),
      unitCostForPositiveAdjustment:
        line.unitCostForPositiveAdjustment !== null
          ? roundQuantity(line.unitCostForPositiveAdjustment)
          : null
    }))
    .sort((a, b) => {
      const location = a.locationId.localeCompare(b.locationId);
      if (location !== 0) return location;
      const item = a.itemId.localeCompare(b.itemId);
      if (item !== 0) return item;
      return a.uom.localeCompare(b.uom);
    });
  const normalized = {
    countId: params.countId,
    warehouseId: params.warehouseId,
    occurredAt: params.occurredAt,
    lines
  };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { normalized, hash };
}

function inventoryCountPostIncompleteError(
  cycleCountId: string,
  details?: Record<string, unknown>
) {
  const error = new Error('INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE';
  error.details = {
    missingMovementId: true,
    cycleCountId,
    hint: 'Retry with the same Idempotency-Key or contact admin',
    ...(details ?? {})
  };
  return error;
}

function inventoryCountReconciliationEscalationError(details: Record<string, unknown>) {
  const error = new Error('COUNT_RECONCILIATION_ESCALATION_REQUIRED') as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.code = 'COUNT_RECONCILIATION_ESCALATION_REQUIRED';
  error.details = details;
  return error;
}

type CycleCountPostExecutionRow = {
  id: string;
  cycle_count_id: string;
  request_hash: string;
  status: string;
  inventory_movement_id: string | null;
};

function buildInventoryCountPostedEvent(
  countId: string,
  movementId: string,
  producerIdempotencyKey: string
): InventoryCommandEvent {
  return buildInventoryRegistryEvent('inventoryCountPosted', {
    producerIdempotencyKey,
    payload: {
      countId,
      movementId
    }
  });
}

function countExpectedInventoryCountMovementLines(lines: CycleCountLineRow[]) {
  return lines.filter((line) => Math.abs(toNumber(line.variance_quantity ?? 0)) > 1e-6).length;
}

async function buildInventoryCountReplayResult(params: {
  tenantId: string;
  countId: string;
  movementId: string;
  idempotencyKey: string;
  expectedLineCount: number;
  expectedDeterministicHash?: string | null;
  client: PoolClient;
}) {
  return buildPostedDocumentReplayResult({
    tenantId: params.tenantId,
    authoritativeMovements: [
      {
        movementId: params.movementId,
        expectedLineCount: params.expectedLineCount,
        expectedDeterministicHash: params.expectedDeterministicHash ?? null
      }
    ],
    client: params.client,
    fetchAggregateView: () => fetchCycleCountById(params.tenantId, params.countId, params.client),
    aggregateNotFoundError: new Error('COUNT_NOT_FOUND'),
    authoritativeEvents: [
      buildMovementPostedEvent(params.movementId, params.idempotencyKey),
      buildInventoryCountPostedEvent(params.countId, params.movementId, params.idempotencyKey)
    ],
    responseStatus: 200
  });
}

export async function createInventoryCount(
  tenantId: string,
  data: InventoryCountInput,
  options?: { idempotencyKey?: string | null }
) {
  if (!data.warehouseId) {
    throw new Error('WAREHOUSE_SCOPE_REQUIRED');
  }
  const normalizedLines = normalizeCountLines(data);
  const countId = uuidv4();
  const now = new Date();
  const idempotencyKey = options?.idempotencyKey ?? null;
  const representativeLocationId = normalizedLines[0]?.locationId ?? data.locationId ?? null;

  await withTransaction(async (client: PoolClient) => {
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM cycle_counts WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return;
      }
    }
    for (const line of normalizedLines) {
      const resolvedWarehouseId = await resolveWarehouseIdForLocation(tenantId, line.locationId, client);
      if (!resolvedWarehouseId) {
        throw new Error('WAREHOUSE_SCOPE_REQUIRED');
      }
      if (resolvedWarehouseId !== data.warehouseId) {
        throw new Error('WAREHOUSE_SCOPE_MISMATCH');
      }
    }

    await client.query(
      `INSERT INTO cycle_counts (
          id, tenant_id, warehouse_id, status, counted_at, location_id, notes, counter_id, approved_by, approved_at, idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        countId,
        tenantId,
        data.warehouseId,
        new Date(data.countedAt),
        representativeLocationId,
        data.notes ?? null,
        data.counterId ?? null,
        data.approvedBy ?? null,
        data.approvedAt ? new Date(data.approvedAt) : null,
        idempotencyKey,
        now
      ]
    );

    // Capture system_qty_snapshot at task-creation time so the per-task
    // recordCount/reconcileTask workflow has a stable baseline.
    const snapshotMap = await loadSystemOnHandForLines(
      tenantId,
      now.toISOString(),
      normalizedLines.map((l) => ({ itemId: l.itemId, locationId: l.locationId, uom: l.uom })),
      client
    );

    for (const line of normalizedLines) {
      const snapshot = snapshotMap.get(makeOnHandKey(line.itemId, line.locationId, line.uom)) ?? 0;
      await client.query(
        `INSERT INTO cycle_count_lines (
            id, tenant_id, cycle_count_id, line_number, item_id, location_id, uom, counted_quantity,
            unit_cost_for_positive_adjustment, reason_code, notes, system_qty_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          uuidv4(),
          tenantId,
          countId,
          line.lineNumber,
          line.itemId,
          line.locationId,
          line.uom,
          line.countedQuantity,
          line.unitCostForPositiveAdjustment,
          line.reasonCode,
          line.notes,
          snapshot
        ]
      );
    }
  });

  const countIdResolved = idempotencyKey
    ? (await pool.query<{ id: string }>(
        'SELECT id FROM cycle_counts WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantId, idempotencyKey]
      )).rows[0]?.id ?? countId
    : countId;
  const count = await fetchCycleCountById(tenantId, countIdResolved);
  if (!count) {
    throw new Error('COUNT_NOT_FOUND');
  }
  return count;
}

export async function getInventoryCount(tenantId: string, id: string) {
  return fetchCycleCountById(tenantId, id);
}

export async function listInventoryCounts(
  tenantId: string,
  warehouseId: string | null,
  status: string | undefined,
  limit: number,
  offset: number
) {
  const params: any[] = [tenantId];
  const where: string[] = ['tenant_id = $1'];
  if (warehouseId) {
    params.push(warehouseId);
    where.push(`warehouse_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  params.push(limit, offset);
  const result = await pool.query<CycleCountRow>(
    `SELECT *
       FROM cycle_counts
      WHERE ${where.join(' AND ')}
      ORDER BY counted_at DESC, created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

export async function updateInventoryCount(
  tenantId: string,
  id: string,
  data: InventoryCountUpdateInput
) {
  const count = await withTransaction(async (client) => {
    const now = new Date();
    const countRes = await client.query<CycleCountRow>(
      `SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    );
    if (countRes.rowCount === 0) {
      throw new Error('COUNT_NOT_FOUND');
    }
    const header = countRes.rows[0];
    if (header.status === 'completed') {
      throw new Error('COUNT_ALREADY_COMPLETED');
    }
    if (header.status === 'in_progress') {
      throw new Error('COUNT_MUTATION_NOT_ALLOWED');
    }
    if (header.status !== 'draft') {
      throw new Error('COUNT_NOT_DRAFT');
    }

    if (data.lines) {
      const normalizedLines = normalizeCountLines({
        warehouseId: header.warehouse_id,
        locationId: header.location_id ?? undefined,
        countedAt: data.countedAt ?? header.counted_at,
        notes: data.notes ?? header.notes ?? undefined,
        counterId: header.counter_id ?? undefined,
        approvedBy: header.approved_by ?? undefined,
        approvedAt: header.approved_at ?? undefined,
        lines: data.lines
      });
      for (const line of normalizedLines) {
        const resolvedWarehouseId = await resolveWarehouseIdForLocation(tenantId, line.locationId, client);
        if (!resolvedWarehouseId || resolvedWarehouseId !== header.warehouse_id) {
          throw new Error('WAREHOUSE_SCOPE_MISMATCH');
        }
      }
      const representativeLocationId = normalizedLines[0]?.locationId ?? header.location_id ?? null;
      await client.query(
        `UPDATE cycle_counts
            SET counted_at = $1,
                notes = $2,
                location_id = $3,
                updated_at = $4
          WHERE id = $5
            AND tenant_id = $6`,
        [
          data.countedAt ? new Date(data.countedAt) : header.counted_at,
          data.notes ?? header.notes,
          representativeLocationId,
          now,
          id,
          tenantId
        ]
      );
      await client.query(
        `DELETE FROM cycle_count_lines
          WHERE cycle_count_id = $1
            AND tenant_id = $2`,
        [id, tenantId]
      );
      const snapshotMapUpdate = await loadSystemOnHandForLines(
        tenantId,
        now.toISOString(),
        normalizedLines.map((l) => ({ itemId: l.itemId, locationId: l.locationId, uom: l.uom })),
        client
      );
      for (const line of normalizedLines) {
        const snapshot = snapshotMapUpdate.get(makeOnHandKey(line.itemId, line.locationId, line.uom)) ?? 0;
        await client.query(
          `INSERT INTO cycle_count_lines (
              id, tenant_id, cycle_count_id, line_number, item_id, location_id, uom, counted_quantity,
              unit_cost_for_positive_adjustment, reason_code, notes, system_qty_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            uuidv4(),
            tenantId,
            id,
            line.lineNumber,
            line.itemId,
            line.locationId,
            line.uom,
            line.countedQuantity,
            line.unitCostForPositiveAdjustment,
            line.reasonCode,
            line.notes,
            snapshot
          ]
        );
      }
    } else {
      await client.query(
        `UPDATE cycle_counts
            SET counted_at = COALESCE($1, counted_at),
                notes = COALESCE($2, notes),
                updated_at = $3
          WHERE id = $4
            AND tenant_id = $5`,
        [data.countedAt ? new Date(data.countedAt) : null, data.notes ?? null, now, id, tenantId]
      );
    }
    return fetchCycleCountById(tenantId, id, client);
  });

  if (!count) {
    throw new Error('COUNT_NOT_FOUND');
  }
  return count;
}

export async function postInventoryCount(
  tenantId: string,
  id: string,
  idempotencyKey: string,
  context?: {
    expectedWarehouseId?: string | null;
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  if (!idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }
  let cycleCount: CycleCountRow | null = null;
  let countLines: CycleCountLineRow[] = [];
  let execution: CycleCountPostExecutionRow | null = null;
  let replayMovementId: string | null = null;

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.INVENTORY_COUNTS_POST,
    operation: 'inventory_count_post',
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },
    lockTargets: async (client) => {
      const now = new Date();
      const countResult = await client.query<CycleCountRow>(
        'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, tenantId]
      );
      if (countResult.rowCount === 0) {
        throw new Error('COUNT_NOT_FOUND');
      }
      cycleCount = countResult.rows[0];
      if (
        context?.expectedWarehouseId
        && context.expectedWarehouseId !== cycleCount.warehouse_id
      ) {
        const error = new Error('WAREHOUSE_SCOPE_MISMATCH') as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        error.code = 'WAREHOUSE_SCOPE_MISMATCH';
        error.details = {
          providedWarehouseId: context.expectedWarehouseId,
          derivedWarehouseId: cycleCount.warehouse_id
        };
        throw error;
      }

      const linesResult = await client.query<CycleCountLineRow>(
        `SELECT *
           FROM cycle_count_lines
          WHERE cycle_count_id = $1
            AND tenant_id = $2
          ORDER BY location_id ASC, item_id ASC, uom ASC, line_number ASC
          FOR UPDATE`,
        [id, tenantId]
      );
      if (linesResult.rowCount === 0) {
        throw new Error('COUNT_NO_LINES');
      }
      countLines = linesResult.rows;

      const { normalized: normalizedRequestSummary, hash: requestHash } = normalizeCycleCountPostingPayload({
        countId: id,
        warehouseId: cycleCount.warehouse_id,
        occurredAt: cycleCount.counted_at,
        lines: countLines.map((line) => ({
          itemId: line.item_id,
          locationId: line.location_id,
          uom: line.uom,
          countedQuantity: toNumber(line.counted_quantity),
          unitCostForPositiveAdjustment:
            line.unit_cost_for_positive_adjustment !== null
              ? toNumber(line.unit_cost_for_positive_adjustment)
              : null
        }))
      });

      const executionInsert = await client.query<{ id: string }>(
        `INSERT INTO cycle_count_post_executions (
            id, tenant_id, cycle_count_id, idempotency_key, request_hash, request_summary, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'IN_PROGRESS', $7, $7)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [uuidv4(), tenantId, id, idempotencyKey, requestHash, JSON.stringify(normalizedRequestSummary), now]
      );

      const executionResult = await client.query<CycleCountPostExecutionRow>(
        `SELECT id, cycle_count_id, request_hash, status, inventory_movement_id
           FROM cycle_count_post_executions
          WHERE tenant_id = $1
            AND idempotency_key = $2
          FOR UPDATE`,
        [tenantId, idempotencyKey]
      );
      if (executionResult.rowCount === 0) {
        throw inventoryCountPostIncompleteError(id, {
          reason: 'execution_row_missing'
        });
      }
      execution = executionResult.rows[0];
      const executionCreated = (executionInsert.rowCount ?? 0) > 0;
      if (execution.cycle_count_id !== id || execution.request_hash !== requestHash) {
        const error = new Error('INV_COUNT_POST_IDEMPOTENCY_CONFLICT') as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        error.code = 'INV_COUNT_POST_IDEMPOTENCY_CONFLICT';
        error.details = {
          cycleCountId: execution.cycle_count_id,
          expectedCycleCountId: id
        };
        throw error;
      }
      if (execution.status === 'SUCCEEDED' && !execution.inventory_movement_id) {
        throw inventoryCountPostIncompleteError(id, {
          reason: 'execution_succeeded_without_movement'
        });
      }
      if (!executionCreated && execution.status === 'IN_PROGRESS') {
        throw inventoryCountPostIncompleteError(id, {
          reason: 'execution_still_in_progress'
        });
      }

      if (cycleCount.status === 'canceled') {
        throw new Error('COUNT_CANCELED');
      }

      if (execution.status === 'SUCCEEDED' && execution.inventory_movement_id) {
        replayMovementId = execution.inventory_movement_id;
        return [];
      }

      if (cycleCount.status === 'posted' && cycleCount.inventory_movement_id) {
        await client.query(
          `UPDATE cycle_count_post_executions
              SET status = 'SUCCEEDED',
                  inventory_movement_id = $1,
                  updated_at = $2
            WHERE id = $3`,
          [cycleCount.inventory_movement_id, now, execution.id]
        );
        replayMovementId = cycleCount.inventory_movement_id;
        return [];
      }
      if (cycleCount.status === 'posted' && !cycleCount.inventory_movement_id) {
        throw inventoryCountPostIncompleteError(id, {
          reason: 'cycle_count_posted_without_movement'
        });
      }

      return countLines.map((line) => ({
        tenantId,
        warehouseId: cycleCount!.warehouse_id,
        itemId: line.item_id
      }));
    },
    execute: async ({ client }) => {
      if (!cycleCount) {
        throw new Error('COUNT_NOT_FOUND');
      }
      if (!execution) {
        throw inventoryCountPostIncompleteError(id, {
          reason: 'execution_row_missing'
        });
      }
      const currentCycleCount = cycleCount;

      if (replayMovementId) {
        return buildInventoryCountReplayResult({
          tenantId,
          countId: id,
          movementId: replayMovementId,
          idempotencyKey,
          expectedLineCount: countExpectedInventoryCountMovementLines(countLines),
          client
        });
      }

      const now = new Date();
      const systemMap = await loadSystemOnHandForLines(
        tenantId,
        now.toISOString(),
        countLines.map((line) => ({
          itemId: line.item_id,
          locationId: line.location_id,
          uom: line.uom
        })),
        client
      );

      const deltas = countLines.map((line) => {
        const countedQty = toNumber(line.counted_quantity);
        const systemQty = systemMap.get(makeOnHandKey(line.item_id, line.location_id, line.uom)) ?? 0;
        return {
          line,
          countedQty,
          systemQty,
          variance: roundQuantity(countedQty - systemQty)
        };
      });

      const missingReason = deltas.find((delta) => delta.variance !== 0 && !delta.line.reason_code);
      if (missingReason) {
        throw new Error('COUNT_REASON_REQUIRED');
      }
      const reconciliationPolicy = getInventoryReconciliationPolicy();
      const escalationRequired = deltas.find(
        (delta) =>
          Math.abs(delta.variance) - reconciliationPolicy.autoAdjustMaxAbsQuantity > 1e-6
          && !context?.overrideRequested
      );
      if (escalationRequired) {
        throw inventoryCountReconciliationEscalationError({
          countId: id,
          itemId: escalationRequired.line.item_id,
          locationId: escalationRequired.line.location_id,
          uom: escalationRequired.line.uom,
          countedQuantity: escalationRequired.countedQty,
          systemQuantity: escalationRequired.systemQty,
          varianceQuantity: escalationRequired.variance,
          autoAdjustMaxAbsQuantity: reconciliationPolicy.autoAdjustMaxAbsQuantity
        });
      }

      const missingPositiveCost = deltas.find(
        (delta) => delta.variance > 0 && delta.line.unit_cost_for_positive_adjustment === null
      );
      if (missingPositiveCost) {
        throw new Error('CYCLE_COUNT_UNIT_COST_REQUIRED');
      }

      const negativeLines = deltas
        .filter((delta) => delta.variance < 0)
        .map((delta) => ({
          warehouseId: currentCycleCount.warehouse_id,
          itemId: delta.line.item_id,
          locationId: delta.line.location_id,
          uom: delta.line.uom,
          quantityToConsume: Math.abs(delta.variance)
        }));
      const validation = negativeLines.length
        ? await validateSufficientStock(
            tenantId,
            now,
            negativeLines,
            {
              actorId: context?.actor?.id ?? null,
              actorRole: context?.actor?.role ?? null,
              overrideRequested: context?.overrideRequested,
              overrideReason: context?.overrideReason ?? null,
              overrideReference: `cycle_count:${id}`
            },
            { client }
          )
        : {};

      const projectionOps: InventoryCommandProjectionOp[] = [];
      const itemsToRefresh = new Set<string>();
      const preparedDeltas: Array<{
        delta: typeof deltas[number];
        canonicalFields: Awaited<ReturnType<typeof getCanonicalMovementFields>>;
      }> = [];
      for (const delta of deltas) {
        await client.query(
          `UPDATE cycle_count_lines
              SET system_quantity = $1,
                  variance_quantity = $2
           WHERE id = $3
             AND tenant_id = $4`,
          [delta.systemQty, delta.variance, delta.line.id, tenantId]
        );

        if (Math.abs(delta.variance) <= 1e-6) {
          continue;
        }

        const canonicalFields = await getCanonicalMovementFields(
          tenantId,
          delta.line.item_id,
          delta.variance,
          delta.line.uom,
          client
        );
        preparedDeltas.push({
          delta,
          canonicalFields
        });
      }

      const sortedPreparedDeltas = sortDeterministicMovementLines(
        preparedDeltas,
        (entry) => ({
          tenantId,
          warehouseId: currentCycleCount.warehouse_id,
          locationId: entry.delta.line.location_id,
          itemId: entry.delta.line.item_id,
          canonicalUom: entry.canonicalFields.canonicalUom,
          sourceLineId: entry.delta.line.id
        })
      );
      const movementId = uuidv4();
      const plannedMovementLines: Array<{
        delta: (typeof sortedPreparedDeltas)[number]['delta'];
        canonicalFields: (typeof sortedPreparedDeltas)[number]['canonicalFields'];
        unitCost: number | null;
        extendedCost: number | null;
        consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>> | null;
      }> = [];
      for (const preparedDelta of sortedPreparedDeltas) {
        const { delta, canonicalFields } = preparedDelta;
        const canonicalQty = canonicalFields.quantityDeltaCanonical;
        let unitCost: number | null = null;
        let extendedCost: number | null = null;
        let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>> | null = null;

        if (delta.variance < 0) {
          consumptionPlan = await planCostLayerConsumption({
            tenant_id: tenantId,
            item_id: delta.line.item_id,
            location_id: delta.line.location_id,
            quantity: Math.abs(canonicalQty),
            consumption_type: 'adjustment',
            consumption_document_id: id,
            movement_id: movementId,
            notes: `Cycle count shrink ${id} line ${delta.line.line_number}`,
            client
          });
          unitCost = Math.abs(canonicalQty) > 0 ? consumptionPlan.total_cost / Math.abs(canonicalQty) : null;
          extendedCost = consumptionPlan.total_cost !== null ? -consumptionPlan.total_cost : null;
        } else {
          unitCost = toNumber(delta.line.unit_cost_for_positive_adjustment ?? 0);
          extendedCost = roundQuantity(canonicalQty * unitCost);
        }

        plannedMovementLines.push({
          delta,
          canonicalFields,
          unitCost,
          extendedCost,
          consumptionPlan
        });
      }

      const movement = await persistInventoryMovement(client, {
        id: movementId,
        tenantId,
        movementType: 'adjustment',
        status: 'posted',
        externalRef: `cycle_count:${id}`,
        sourceType: 'cycle_count_post',
        sourceId: id,
        idempotencyKey: `cycle-count-post:${id}:${idempotencyKey}`,
        occurredAt: now,
        postedAt: now,
        notes: currentCycleCount.notes ?? null,
        metadata: validation.overrideMetadata ?? null,
        createdAt: now,
        updatedAt: now,
        lines: plannedMovementLines.map((plannedLine) => ({
          warehouseId: currentCycleCount.warehouse_id,
          sourceLineId: plannedLine.delta.line.id,
          eventTimestamp: now,
          itemId: plannedLine.delta.line.item_id,
          locationId: plannedLine.delta.line.location_id,
          quantityDelta: plannedLine.canonicalFields.quantityDeltaCanonical,
          uom: plannedLine.canonicalFields.canonicalUom,
          quantityDeltaEntered: plannedLine.canonicalFields.quantityDeltaEntered,
          uomEntered: plannedLine.canonicalFields.uomEntered,
          quantityDeltaCanonical: plannedLine.canonicalFields.quantityDeltaCanonical,
          canonicalUom: plannedLine.canonicalFields.canonicalUom,
          uomDimension: plannedLine.canonicalFields.uomDimension,
          unitCost: plannedLine.unitCost,
          extendedCost: plannedLine.extendedCost,
          reasonCode: plannedLine.delta.line.reason_code ?? 'cycle_count_adjustment',
          lineNotes:
            plannedLine.delta.line.notes
            ?? `Cycle count ${id} line ${plannedLine.delta.line.line_number}`,
          createdAt: now
        }))
      });
      if (!movement.created) {
        const lineCheck = await client.query(
          `SELECT 1
             FROM inventory_movement_lines
            WHERE tenant_id = $1
              AND movement_id = $2
            LIMIT 1`,
          [tenantId, movement.movementId]
        );
        if (lineCheck.rowCount === 0) {
          throw inventoryCountPostIncompleteError(id, {
            movementId: movement.movementId,
            reason: 'movement_exists_without_lines'
          });
        }
        await client.query(
          `UPDATE cycle_counts
              SET status = 'posted',
                  inventory_movement_id = $1,
                  posted_at = COALESCE(posted_at, $2),
                  updated_at = $2
            WHERE id = $3
              AND tenant_id = $4`,
          [movement.movementId, now, id, tenantId]
        );
        await client.query(
          `UPDATE cycle_count_post_executions
              SET status = 'SUCCEEDED',
                  inventory_movement_id = $1,
                  updated_at = $2
            WHERE id = $3`,
          [movement.movementId, now, execution.id]
        );
        return buildInventoryCountReplayResult({
          tenantId,
          countId: id,
          movementId: movement.movementId,
          idempotencyKey,
          expectedLineCount: sortedPreparedDeltas.length,
          client
        });
      }

      for (const plannedLine of plannedMovementLines) {
        const { delta, canonicalFields, unitCost, consumptionPlan } = plannedLine;
        const canonicalQty = canonicalFields.quantityDeltaCanonical;

        if (delta.variance < 0) {
          if (!consumptionPlan) {
            throw new Error('INV_COUNT_COST_PLAN_REQUIRED');
          }
          await applyPlannedCostLayerConsumption({
            tenant_id: tenantId,
            item_id: delta.line.item_id,
            location_id: delta.line.location_id,
            quantity: Math.abs(canonicalQty),
            consumption_type: 'adjustment',
            consumption_document_id: id,
            movement_id: movement.movementId,
            notes: `Cycle count shrink ${id} line ${delta.line.line_number}`,
            client,
            plan: consumptionPlan
          });
        } else {
          await createCostLayer({
            tenant_id: tenantId,
            item_id: delta.line.item_id,
            location_id: delta.line.location_id,
            uom: canonicalFields.canonicalUom,
            quantity: canonicalQty,
            unit_cost: unitCost ?? 0,
            source_type: 'adjustment',
            source_document_id: id,
            movement_id: movement.movementId,
            notes: `Cycle count found ${id} line ${delta.line.line_number}`,
            client
          });
        }

        projectionOps.push(
          buildInventoryBalanceProjectionOp({
            tenantId,
            itemId: delta.line.item_id,
            locationId: delta.line.location_id,
            uom: canonicalFields.canonicalUom,
            deltaOnHand: canonicalQty,
            mutationContext: {
              movementId: movement.movementId,
              sourceLineId: delta.line.id,
              reasonCode: delta.line.reason_code ?? 'cycle_count_adjustment',
              eventTimestamp: now,
              stateTransition: canonicalQty > 0 ? 'adjusted->available' : 'available->adjusted'
            }
          })
        );
        itemsToRefresh.add(delta.line.item_id);
      }

      for (const itemId of itemsToRefresh.values()) {
        projectionOps.push(buildRefreshItemCostSummaryProjectionOp(tenantId, itemId));
      }

      const postReconcileMap = await loadSystemOnHandForLines(
        tenantId,
        now.toISOString(),
        deltas.map((delta) => ({
          itemId: delta.line.item_id,
          locationId: delta.line.location_id,
          uom: delta.line.uom
        })),
        client
      );
      const mismatch = deltas.find((delta) => {
        const finalOnHand = postReconcileMap.get(
          makeOnHandKey(delta.line.item_id, delta.line.location_id, delta.line.uom)
        ) ?? 0;
        return Math.abs(finalOnHand - delta.countedQty) > 1e-6;
      });
      if (mismatch) {
        throw new Error('CYCLE_COUNT_RECONCILIATION_FAILED');
      }

      await client.query(
        `UPDATE cycle_counts
            SET status = 'posted',
                inventory_movement_id = $1,
                posted_at = $2,
                updated_at = $2
         WHERE id = $3
           AND tenant_id = $4`,
        [movement.movementId, now, id, tenantId]
      );

      await client.query(
        `UPDATE cycle_count_post_executions
            SET status = 'SUCCEEDED',
                inventory_movement_id = $1,
                updated_at = $2
          WHERE id = $3`,
        [movement.movementId, now, execution.id]
      );

      if (validation.overrideMetadata && context?.actor) {
        await recordAuditLog(
          {
            tenantId,
            actorType: context.actor.type,
            actorId: context.actor.id ?? null,
            action: 'negative_override',
            entityType: 'inventory_movement',
            entityId: movement.movementId,
            occurredAt: now,
            metadata: {
              reason: validation.overrideMetadata.override_reason ?? null,
              cycleCountId: id,
              lines: negativeLines,
              reference: validation.overrideMetadata.override_reference ?? null
            }
          },
          client
        );
      }

      const count = await fetchCycleCountById(tenantId, id, client);
      if (!count) {
        throw new Error('COUNT_NOT_FOUND');
      }
      return {
        responseBody: count,
        responseStatus: 200,
        events: [
          buildMovementPostedEvent(movement.movementId, idempotencyKey),
          buildInventoryCountPostedEvent(id, movement.movementId, idempotencyKey)
        ],
        projectionOps
      };
    }
  });
}

/**
 * recordCount — update the physical counted quantity for a specific task.
 *
 * Uses the immutable system_qty_snapshot captured at task-creation time to
 * compute variance. Once recorded the task transitions to 'counted'.
 * Re-calling with the same qty is idempotent; re-calling with a different qty
 * updates the count (task must not yet be reconciled).
 */
export async function recordCount(
  tenantId: string,
  countId: string,
  lineId: string,
  countedQty: number
) {
  if (!Number.isFinite(countedQty) || countedQty < 0) {
    throw new Error('COUNT_QUANTITY_NONNEGATIVE');
  }
  const rounded = roundQuantity(countedQty);

  return withTransaction(async (client: PoolClient) => {
    const countResult = await client.query<CycleCountRow>(
      'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [countId, tenantId]
    );
    if (countResult.rowCount === 0) {
      throw new Error('COUNT_NOT_FOUND');
    }
    const cycleCount = countResult.rows[0];
    if (cycleCount.status === 'completed') {
      throw new Error('COUNT_ALREADY_COMPLETED');
    }
    if (cycleCount.status === 'posted') {
      throw new Error('COUNT_ALREADY_POSTED');
    }
    if (cycleCount.status === 'canceled') {
      throw new Error('COUNT_CANCELED');
    }

    const lineResult = await client.query<CycleCountLineRow>(
      `SELECT * FROM cycle_count_lines
        WHERE id = $1
          AND cycle_count_id = $2
          AND tenant_id = $3
        FOR UPDATE`,
      [lineId, countId, tenantId]
    );
    if (lineResult.rowCount === 0) {
      throw new Error('COUNT_LINE_NOT_FOUND');
    }
    const line = lineResult.rows[0];

    if (line.task_status === 'reconciled') {
      throw new Error('COUNT_TASK_ALREADY_RECONCILED');
    }

    const snapshot = roundQuantity(toNumber(line.system_qty_snapshot ?? 0));
    const now = new Date();

    await client.query(
      `UPDATE cycle_count_lines
          SET counted_quantity = $1,
              task_status      = 'counted'
        WHERE id        = $2
          AND tenant_id = $3`,
      [rounded, lineId, tenantId]
    );

    // Transition session to in_progress if still draft
    if (cycleCount.status === 'draft') {
      await client.query(
        `UPDATE cycle_counts
            SET status     = 'in_progress',
                updated_at = $1
          WHERE id        = $2
            AND tenant_id = $3`,
        [now, countId, tenantId]
      );
    }

    return fetchCycleCountById(tenantId, countId, client);
  });
}

/**
 * reconcileTask — reconcile a single counted task against the inventory ledger.
 *
 * Zero variance: marks the task 'reconciled' with no inventory movement.
 * Non-zero variance: requires a reasonCode, validates the threshold policy,
 * then posts an adjustment movement (via ledger) and marks the task reconciled.
 *
 * Idempotent: if the task is already 'reconciled' the current state is returned.
 * Concurrency: the task row is locked FOR UPDATE; a second concurrent call blocks
 * until the first completes, then sees task_status='reconciled' and replays.
 */
export async function reconcileTask(
  tenantId: string,
  countId: string,
  lineId: string,
  idempotencyKey: string,
  options?: {
    reasonCode?: string | null;
    overrideRequested?: boolean;
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
  }
) {
  if (!idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  let cycleCount: CycleCountRow | null = null;
  let countLine: CycleCountLineRow | null = null;

  return runInventoryCommand<any>({
    tenantId,
    endpoint: IDEMPOTENCY_ENDPOINTS.CYCLE_COUNT_RECONCILE_TASK,
    operation: 'cycle_count_reconcile_task',
    retryOptions: { isolationLevel: 'SERIALIZABLE', retries: 2 },

    lockTargets: async (client) => {
      const countResult = await client.query<CycleCountRow>(
        'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [countId, tenantId]
      );
      if (countResult.rowCount === 0) {
        throw new Error('COUNT_NOT_FOUND');
      }
      cycleCount = countResult.rows[0];
      if (cycleCount.status === 'completed') {
        throw new Error('COUNT_ALREADY_COMPLETED');
      }
      if (cycleCount.status === 'posted') {
        throw new Error('COUNT_ALREADY_POSTED');
      }
      if (cycleCount.status === 'canceled') {
        throw new Error('COUNT_CANCELED');
      }

      const lineResult = await client.query<CycleCountLineRow>(
        `SELECT * FROM cycle_count_lines
          WHERE id = $1
            AND cycle_count_id = $2
            AND tenant_id = $3
          FOR UPDATE`,
        [lineId, countId, tenantId]
      );
      if (lineResult.rowCount === 0) {
        throw new Error('COUNT_LINE_NOT_FOUND');
      }
      countLine = lineResult.rows[0];

      if (countLine.task_status === 'pending') {
        throw new Error('COUNT_TASK_NOT_COUNTED');
      }

      // Already reconciled — skip lock acquisition, replay in execute
      if (countLine.task_status === 'reconciled') {
        return [];
      }

      const variance = roundQuantity(
        toNumber(countLine.counted_quantity) - toNumber(countLine.system_qty_snapshot ?? 0)
      );
      if (Math.abs(variance) <= 1e-6) {
        // Zero variance — no ATP lock needed
        return [];
      }

      return [{ tenantId, warehouseId: cycleCount.warehouse_id, itemId: countLine.item_id }];
    },

    execute: async ({ client }) => {
      if (!cycleCount || !countLine) {
        throw new Error('COUNT_NOT_FOUND');
      }
      const now = new Date();

      // Idempotent replay: task already reconciled
      if (countLine.task_status === 'reconciled') {
        const view = await fetchCycleCountById(tenantId, countId, client);
        return { responseBody: view, responseStatus: 200 };
      }

      const variance = roundQuantity(
        toNumber(countLine.counted_quantity) - toNumber(countLine.system_qty_snapshot ?? 0)
      );
      const countedQty = roundQuantity(toNumber(countLine.counted_quantity));
      const currentCycleCount = cycleCount;
      const currentLine = countLine;

      // ── Zero variance path ───────────────────────────────────────────────
      if (Math.abs(variance) <= 1e-6) {
        await client.query(
          `UPDATE cycle_count_lines
              SET task_status       = 'reconciled',
                  variance_quantity = $1
            WHERE id        = $2
              AND tenant_id = $3`,
          [0, lineId, tenantId]
        );
        const view = await fetchCycleCountById(tenantId, countId, client);
        return { responseBody: view, responseStatus: 200 };
      }

      // ── Non-zero variance path ───────────────────────────────────────────
      const effectiveReasonCode =
        (options?.reasonCode ?? currentLine.reason_code) || null;
      if (!effectiveReasonCode) {
        throw new Error('COUNT_REASON_REQUIRED');
      }

      const reconciliationPolicy = getInventoryReconciliationPolicy();
      if (
        Math.abs(variance) - reconciliationPolicy.autoAdjustMaxAbsQuantity > 1e-6
        && !options?.overrideRequested
      ) {
        throw inventoryCountReconciliationEscalationError({
          countId,
          lineId,
          itemId: currentLine.item_id,
          locationId: currentLine.location_id,
          uom: currentLine.uom,
          countedQuantity: countedQty,
          systemQtySnapshot: roundQuantity(toNumber(currentLine.system_qty_snapshot ?? 0)),
          varianceQuantity: variance,
          autoAdjustMaxAbsQuantity: reconciliationPolicy.autoAdjustMaxAbsQuantity
        });
      }

      // Validate positive-variance unit cost
      if (variance > 0 && currentLine.unit_cost_for_positive_adjustment === null) {
        throw new Error('CYCLE_COUNT_UNIT_COST_REQUIRED');
      }

      // Validate sufficient stock for negative variances
      const negativeCheck =
        variance < 0
          ? await validateSufficientStock(
              tenantId,
              now,
              [
                {
                  warehouseId: currentCycleCount.warehouse_id,
                  itemId: currentLine.item_id,
                  locationId: currentLine.location_id,
                  uom: currentLine.uom,
                  quantityToConsume: Math.abs(variance)
                }
              ],
              {
                actorId: options?.actor?.id ?? null,
                actorRole: options?.actor?.role ?? null,
                overrideRequested: options?.overrideRequested,
                overrideReason: null,
                overrideReference: `cycle_count_task:${lineId}`
              },
              { client }
            )
          : {};

      const canonicalFields = await getCanonicalMovementFields(
        tenantId,
        currentLine.item_id,
        variance,
        currentLine.uom,
        client
      );
      const canonicalQty = canonicalFields.quantityDeltaCanonical;

      let unitCost: number | null = null;
      let extendedCost: number | null = null;
      let consumptionPlan: Awaited<ReturnType<typeof planCostLayerConsumption>> | null = null;

      const movementId = uuidv4();

      if (variance < 0) {
        consumptionPlan = await planCostLayerConsumption({
          tenant_id: tenantId,
          item_id: currentLine.item_id,
          location_id: currentLine.location_id,
          quantity: Math.abs(canonicalQty),
          consumption_type: 'adjustment',
          consumption_document_id: countId,
          movement_id: movementId,
          notes: `Cycle count task shrink count=${countId} line=${lineId}`,
          client
        });
        unitCost =
          Math.abs(canonicalQty) > 0 ? consumptionPlan.total_cost / Math.abs(canonicalQty) : null;
        extendedCost =
          consumptionPlan.total_cost !== null ? -consumptionPlan.total_cost : null;
      } else {
        unitCost = toNumber(currentLine.unit_cost_for_positive_adjustment ?? 0);
        extendedCost = roundQuantity(canonicalQty * unitCost);
      }

      const movement = await persistInventoryMovement(client, {
        id: movementId,
        tenantId,
        movementType: 'adjustment',
        status: 'posted',
        externalRef: `cycle_count_task:${lineId}`,
        sourceType: 'cycle_count_task',
        sourceId: lineId,
        idempotencyKey: `cycle-count-task-reconcile:${lineId}:${idempotencyKey}`,
        occurredAt: now,
        postedAt: now,
        notes: currentCycleCount.notes ?? null,
        metadata: (negativeCheck as any).overrideMetadata ?? null,
        createdAt: now,
        updatedAt: now,
        lines: [
          {
            warehouseId: currentCycleCount.warehouse_id,
            sourceLineId: lineId,
            eventTimestamp: now,
            itemId: currentLine.item_id,
            locationId: currentLine.location_id,
            quantityDelta: canonicalQty,
            uom: canonicalFields.canonicalUom,
            quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
            uomEntered: canonicalFields.uomEntered,
            quantityDeltaCanonical: canonicalQty,
            canonicalUom: canonicalFields.canonicalUom,
            uomDimension: canonicalFields.uomDimension,
            unitCost,
            extendedCost,
            reasonCode: effectiveReasonCode,
            lineNotes:
              currentLine.notes
              ?? `Cycle count task ${countId} line ${currentLine.line_number}`,
            createdAt: now
          }
        ]
      });

      if (variance < 0) {
        if (!consumptionPlan) {
          throw new Error('INV_COUNT_COST_PLAN_REQUIRED');
        }
        await applyPlannedCostLayerConsumption({
          tenant_id: tenantId,
          item_id: currentLine.item_id,
          location_id: currentLine.location_id,
          quantity: Math.abs(canonicalQty),
          consumption_type: 'adjustment',
          consumption_document_id: countId,
          movement_id: movement.movementId,
          notes: `Cycle count task shrink count=${countId} line=${lineId}`,
          client,
          plan: consumptionPlan
        });
      } else {
        await createCostLayer({
          tenant_id: tenantId,
          item_id: currentLine.item_id,
          location_id: currentLine.location_id,
          uom: canonicalFields.canonicalUom,
          quantity: canonicalQty,
          unit_cost: unitCost ?? 0,
          source_type: 'adjustment',
          source_document_id: countId,
          movement_id: movement.movementId,
          notes: `Cycle count task found count=${countId} line=${lineId}`,
          client
        });
      }

      // Mark task reconciled with link to movement
      await client.query(
        `UPDATE cycle_count_lines
            SET task_status             = 'reconciled',
                variance_quantity       = $1,
                reason_code             = $2,
                reconciled_movement_id  = $3,
                reconciled_at           = $4
          WHERE id        = $5
            AND tenant_id = $6`,
        [variance, effectiveReasonCode, movement.movementId, now, lineId, tenantId]
      );

      // Conservation check: final on-hand must equal counted qty
      const postReconcileMap = await loadSystemOnHandForLines(
        tenantId,
        now.toISOString(),
        [{ itemId: currentLine.item_id, locationId: currentLine.location_id, uom: currentLine.uom }],
        client
      );
      const finalOnHand =
        postReconcileMap.get(
          makeOnHandKey(currentLine.item_id, currentLine.location_id, currentLine.uom)
        ) ?? 0;
      if (Math.abs(finalOnHand - countedQty) > 1e-6) {
        throw new Error('CYCLE_COUNT_RECONCILIATION_FAILED');
      }

      if ((negativeCheck as any).overrideMetadata && options?.actor) {
        await recordAuditLog(
          {
            tenantId,
            actorType: options.actor.type,
            actorId: options.actor.id ?? null,
            action: 'negative_override',
            entityType: 'inventory_movement',
            entityId: movement.movementId,
            occurredAt: now,
            metadata: {
              reason: (negativeCheck as any).overrideMetadata.override_reason ?? null,
              cycleCountId: countId,
              lineId,
              reference: (negativeCheck as any).overrideMetadata.override_reference ?? null
            }
          },
          client
        );
      }

      const projectionOps: InventoryCommandProjectionOp[] = [
        buildInventoryBalanceProjectionOp({
          tenantId,
          itemId: currentLine.item_id,
          locationId: currentLine.location_id,
          uom: canonicalFields.canonicalUom,
          deltaOnHand: canonicalQty,
          mutationContext: {
            movementId: movement.movementId,
            sourceLineId: lineId,
            reasonCode: effectiveReasonCode,
            eventTimestamp: now,
            stateTransition: canonicalQty > 0 ? 'adjusted->available' : 'available->adjusted'
          }
        }),
        buildRefreshItemCostSummaryProjectionOp(tenantId, currentLine.item_id)
      ];

      const view = await fetchCycleCountById(tenantId, countId, client);
      return {
        responseBody: view,
        responseStatus: 200,
        projectionOps
      };
    }
  });
}

/**
 * completeCycleCount — transition a session to 'completed'.
 *
 * Preconditions (enforced under session row lock):
 *   - session must be in_progress
 *   - ALL cycle_count_lines must have task_status = 'reconciled'
 *
 * Idempotent: if already completed, returns current state without error.
 * Concurrency: session row is locked FOR UPDATE before the line check,
 * so a concurrent reconcileTask that finishes last and a concurrent
 * completeCycleCount cannot race past the guard.
 */
export async function completeCycleCount(tenantId: string, countId: string) {
  return withTransaction(async (client: PoolClient) => {
    const countResult = await client.query<CycleCountRow>(
      'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [countId, tenantId]
    );
    if (countResult.rowCount === 0) {
      throw new Error('COUNT_NOT_FOUND');
    }
    const cycleCount = countResult.rows[0];

    if (cycleCount.status === 'completed') {
      return fetchCycleCountById(tenantId, countId, client);
    }
    if (cycleCount.status === 'posted') {
      throw new Error('COUNT_ALREADY_POSTED');
    }
    if (cycleCount.status === 'canceled') {
      throw new Error('COUNT_CANCELED');
    }
    if (cycleCount.status === 'draft') {
      throw new Error('COUNT_MUTATION_NOT_ALLOWED');
    }

    // Under the session lock, verify every line is reconciled
    const unreconciledResult = await client.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt
         FROM cycle_count_lines
        WHERE cycle_count_id = $1
          AND tenant_id = $2
          AND task_status != 'reconciled'`,
      [countId, tenantId]
    );
    if (unreconciledResult.rows[0].cnt > 0) {
      throw new Error('COUNT_COMPLETION_INCOMPLETE');
    }

    const now = new Date();
    await client.query(
      `UPDATE cycle_counts SET status = 'completed', updated_at = $1 WHERE id = $2 AND tenant_id = $3`,
      [now, countId, tenantId]
    );

    return fetchCycleCountById(tenantId, countId, client);
  });
}
