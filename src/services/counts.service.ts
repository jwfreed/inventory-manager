import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction, withTransactionRetry } from '../db';
import { inventoryCountSchema, inventoryCountUpdateSchema } from '../schemas/counts.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock } from './stockValidation.service';
import { consumeCostLayers, createCostLayer } from './costLayers.service';
import { getCanonicalMovementFields } from './uomCanonical.service';
import { resolveWarehouseIdForLocation } from './warehouseDefaults.service';
import {
  createInventoryMovement,
  createInventoryMovementLine,
  applyInventoryBalanceDelta,
  enqueueInventoryMovementPosted
} from '../domains/inventory';

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
  variance_quantity: string | number | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
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
  varianceQuantity: number;
  varianceRatio: number;
  variancePct: number;
  accuracyPct: number;
  hit: boolean;
  reasonCode: string | null;
  notes: string | null;
  createdAt: string;
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
      varianceQuantity: variance,
      varianceRatio: roundQuantity(varianceRatio),
      variancePct: roundQuantity(variancePct),
      accuracyPct: roundQuantity(accuracyPct),
      hit,
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
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
    summary
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
        line.unitCostForPositiveAdjustment !== undefined
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
      if (existing.rowCount > 0) {
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

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO cycle_count_lines (
            id, tenant_id, cycle_count_id, line_number, item_id, location_id, uom, counted_quantity,
            unit_cost_for_positive_adjustment, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
          line.notes
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
      for (const line of normalizedLines) {
        await client.query(
          `INSERT INTO cycle_count_lines (
              id, tenant_id, cycle_count_id, line_number, item_id, location_id, uom, counted_quantity,
              unit_cost_for_positive_adjustment, reason_code, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
            line.notes
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
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  if (!idempotencyKey) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }
  const count = await withTransactionRetry(async (client: PoolClient) => {
    const now = new Date();
    const countResult = await client.query<CycleCountRow>(
      'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (countResult.rowCount === 0) {
      throw new Error('COUNT_NOT_FOUND');
    }
    const cycleCount = countResult.rows[0];

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

    const { normalized: normalizedRequestSummary, hash: requestHash } = normalizeCycleCountPostingPayload({
      countId: id,
      warehouseId: cycleCount.warehouse_id,
      occurredAt: cycleCount.counted_at,
      lines: linesResult.rows.map((line) => ({
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

    const executionResult = await client.query<{
      id: string;
      cycle_count_id: string;
      request_hash: string;
      status: string;
      inventory_movement_id: string | null;
    }>(
      `SELECT id, cycle_count_id, request_hash, status, inventory_movement_id
         FROM cycle_count_post_executions
        WHERE tenant_id = $1
          AND idempotency_key = $2
        FOR UPDATE`,
      [tenantId, idempotencyKey]
    );
    if (executionResult.rowCount === 0) {
      throw new Error('INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE');
    }
    const execution = executionResult.rows[0];
    const executionCreated = executionInsert.rowCount > 0;
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
    if (execution.status === 'SUCCEEDED' && execution.inventory_movement_id) {
      return fetchCycleCountById(tenantId, id, client);
    }
    if (execution.status === 'SUCCEEDED' && !execution.inventory_movement_id) {
      const incompleteError = new Error('INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE') as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      incompleteError.code = 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE';
      incompleteError.details = {
        missingMovementId: true,
        cycleCountId: id,
        hint: 'Retry with the same Idempotency-Key or contact admin'
      };
      throw incompleteError;
    }
    if (!executionCreated && execution.status === 'IN_PROGRESS') {
      const incompleteError = new Error('INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE') as Error & {
        code?: string;
        details?: Record<string, unknown>;
      };
      incompleteError.code = 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE';
      incompleteError.details = {
        missingMovementId: true,
        cycleCountId: id,
        hint: 'Retry with the same Idempotency-Key or contact admin'
      };
      throw incompleteError;
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
      return fetchCycleCountById(tenantId, id, client);
    }
    if (cycleCount.status === 'canceled') {
      throw new Error('COUNT_CANCELED');
    }

    const systemMap = await loadSystemOnHandForLines(
      tenantId,
      now.toISOString(),
      linesResult.rows.map((line) => ({
        itemId: line.item_id,
        locationId: line.location_id,
        uom: line.uom
      })),
      client
    );

    const deltas = linesResult.rows.map((line) => {
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

    const missingPositiveCost = deltas.find(
      (delta) => delta.variance > 0 && delta.line.unit_cost_for_positive_adjustment === null
    );
    if (missingPositiveCost) {
      throw new Error('CYCLE_COUNT_UNIT_COST_REQUIRED');
    }

    const negativeLines = deltas
      .filter((delta) => delta.variance < 0)
      .map((delta) => ({
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

    const movement = await createInventoryMovement(client, {
      id: uuidv4(),
      tenantId,
      movementType: 'adjustment',
      status: 'posted',
      externalRef: `cycle_count:${id}`,
      sourceType: 'cycle_count_post',
      sourceId: id,
      idempotencyKey: `cycle-count-post:${id}:${idempotencyKey}`,
      occurredAt: now,
      postedAt: now,
      notes: cycleCount.notes ?? null,
      metadata: validation.overrideMetadata ?? null,
      createdAt: now,
      updatedAt: now
    });

    if (!movement.created) {
      const lineCheck = await client.query(
        `SELECT 1
           FROM inventory_movement_lines
          WHERE movement_id = $1
          LIMIT 1`,
        [movement.id]
      );
      if (lineCheck.rowCount === 0) {
        const incompleteError = new Error('INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE') as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        incompleteError.code = 'INV_COUNT_POST_IDEMPOTENCY_INCOMPLETE';
        incompleteError.details = {
          missingMovementId: true,
          cycleCountId: id,
          hint: 'Retry with the same Idempotency-Key or contact admin'
        };
        throw incompleteError;
      }
      await client.query(
        `UPDATE cycle_counts
            SET status = 'posted',
                inventory_movement_id = $1,
                posted_at = COALESCE(posted_at, $2),
                updated_at = $2
          WHERE id = $3
            AND tenant_id = $4`,
        [movement.id, now, id, tenantId]
      );
      await client.query(
        `UPDATE cycle_count_post_executions
            SET status = 'SUCCEEDED',
                inventory_movement_id = $1,
                updated_at = $2
          WHERE id = $3`,
        [movement.id, now, execution.id]
      );
      await enqueueInventoryMovementPosted(client, tenantId, movement.id);
      return fetchCycleCountById(tenantId, id, client);
    }

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
      const canonicalQty = canonicalFields.quantityDeltaCanonical;
      let unitCost: number | null = null;
      let extendedCost: number | null = null;

      if (delta.variance < 0) {
        const consumption = await consumeCostLayers({
          tenant_id: tenantId,
          item_id: delta.line.item_id,
          location_id: delta.line.location_id,
          quantity: Math.abs(canonicalQty),
          consumption_type: 'adjustment',
          consumption_document_id: id,
          movement_id: movement.id,
          notes: `Cycle count shrink ${id} line ${delta.line.line_number}`,
          client
        });
        unitCost = Math.abs(canonicalQty) > 0 ? consumption.total_cost / Math.abs(canonicalQty) : null;
        extendedCost = consumption.total_cost !== null ? -consumption.total_cost : null;
      } else {
        unitCost = toNumber(delta.line.unit_cost_for_positive_adjustment ?? 0);
        extendedCost = roundQuantity(canonicalQty * unitCost);
        await createCostLayer({
          tenant_id: tenantId,
          item_id: delta.line.item_id,
          location_id: delta.line.location_id,
          uom: canonicalFields.canonicalUom,
          quantity: canonicalQty,
          unit_cost: unitCost,
          source_type: 'adjustment',
          source_document_id: id,
          movement_id: movement.id,
          notes: `Cycle count found ${id} line ${delta.line.line_number}`,
          client
        });
      }

      await createInventoryMovementLine(client, {
        tenantId,
        movementId: movement.id,
        itemId: delta.line.item_id,
        locationId: delta.line.location_id,
        quantityDelta: canonicalQty,
        uom: canonicalFields.canonicalUom,
        quantityDeltaEntered: canonicalFields.quantityDeltaEntered,
        uomEntered: canonicalFields.uomEntered,
        quantityDeltaCanonical: canonicalFields.quantityDeltaCanonical,
        canonicalUom: canonicalFields.canonicalUom,
        uomDimension: canonicalFields.uomDimension,
        unitCost,
        extendedCost,
        reasonCode: delta.line.reason_code ?? 'cycle_count_adjustment',
        lineNotes: delta.line.notes ?? `Cycle count ${id} line ${delta.line.line_number}`
      });

      await applyInventoryBalanceDelta(client, {
        tenantId,
        itemId: delta.line.item_id,
        locationId: delta.line.location_id,
        uom: canonicalFields.canonicalUom,
        deltaOnHand: canonicalQty
      });
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
      [movement.id, now, id, tenantId]
    );

    await client.query(
      `UPDATE cycle_count_post_executions
          SET status = 'SUCCEEDED',
              inventory_movement_id = $1,
              updated_at = $2
        WHERE id = $3`,
      [movement.id, now, execution.id]
    );

    await enqueueInventoryMovementPosted(client, tenantId, movement.id);

    if (validation.overrideMetadata && context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movement.id,
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

    return fetchCycleCountById(tenantId, id, client);
  }, { isolationLevel: 'SERIALIZABLE', retries: 2 });

  return count;
}
