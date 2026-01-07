import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction } from '../db';
import { inventoryCountSchema } from '../schemas/counts.schema';
import { roundQuantity, toNumber } from '../lib/numbers';
import { recordAuditLog } from '../lib/audit';
import { validateSufficientStock } from './stockValidation.service';
import { calculateMovementCost } from './costing.service';
import { consumeCostLayers, createCostLayer } from './costLayers.service';

type InventoryCountInput = z.infer<typeof inventoryCountSchema>;

type CycleCountRow = {
  id: string;
  status: string;
  counted_at: string;
  location_id: string;
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
  uom: string;
  counted_quantity: string | number;
  system_quantity: string | number | null;
  variance_quantity: string | number | null;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
};

type OnHandKey = string;

function makeOnHandKey(itemId: string, uom: string): OnHandKey {
  return `${itemId}:${uom}`;
}

async function loadSystemOnHandForLocation(
  tenantId: string,
  locationId: string,
  countedAt: string,
  items: { itemId: string; uom: string }[],
  client?: PoolClient
): Promise<Map<OnHandKey, number>> {
  const map = new Map<OnHandKey, number>();
  if (items.length === 0) {
    return map;
  }
  const executor = client ?? pool;
  const itemIds = Array.from(new Set(items.map((item) => item.itemId)));
  const { rows } = await executor.query(
    `SELECT l.item_id, l.uom, COALESCE(SUM(l.quantity_delta), 0) AS qty
       FROM inventory_movement_lines l
       JOIN inventory_movements m ON m.id = l.movement_id
      WHERE m.status = 'posted'
        AND l.location_id = $1
        AND m.occurred_at <= $2
        AND l.item_id = ANY($3::uuid[])
        AND l.tenant_id = $4
        AND m.tenant_id = $4
      GROUP BY l.item_id, l.uom`,
    [locationId, countedAt, itemIds, tenantId]
  );
  for (const row of rows) {
    map.set(makeOnHandKey(row.item_id, row.uom), roundQuantity(toNumber(row.qty)));
  }
  return map;
}

type CycleCountLineSummary = {
  id: string;
  lineNumber: number;
  itemId: string;
  uom: string;
  countedQuantity: number;
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
      : systemMap.get(makeOnHandKey(line.item_id, line.uom)) ?? 0;
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
      uom: line.uom,
      countedQuantity: countedQty,
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
  const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
  const systemMap = useSnapshots
    ? new Map<OnHandKey, number>()
    : await loadSystemOnHandForLocation(
        tenantId,
        countResult.rows[0].location_id,
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
    const key = makeOnHandKey(line.itemId, line.uom);
    if (itemUomKeys.has(key)) {
      throw new Error('COUNT_DUPLICATE_ITEM');
    }
    itemUomKeys.add(key);
    return {
      lineNumber,
      itemId: line.itemId,
      uom: line.uom,
      countedQuantity: roundQuantity(line.countedQuantity),
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    };
  });
}

export async function createInventoryCount(tenantId: string, data: InventoryCountInput) {
  const normalizedLines = normalizeCountLines(data);
  const countId = uuidv4();
  const now = new Date();

  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `INSERT INTO cycle_counts (
          id, tenant_id, status, counted_at, location_id, notes, counter_id, approved_by, approved_at, created_at, updated_at
       ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        countId,
        tenantId,
        new Date(data.countedAt),
        data.locationId,
        data.notes ?? null,
        data.counterId ?? null,
        data.approvedBy ?? null,
        data.approvedAt ? new Date(data.approvedAt) : null,
        now
      ]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO cycle_count_lines (
            id, tenant_id, cycle_count_id, line_number, item_id, uom, counted_quantity, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(),
          tenantId,
          countId,
          line.lineNumber,
          line.itemId,
          line.uom,
          line.countedQuantity,
          line.reasonCode,
          line.notes
        ]
      );
    }
  });

  const count = await fetchCycleCountById(tenantId, countId);
  if (!count) {
    throw new Error('COUNT_NOT_FOUND');
  }
  return count;
}

export async function getInventoryCount(tenantId: string, id: string) {
  return fetchCycleCountById(tenantId, id);
}

export async function postInventoryCount(
  tenantId: string,
  id: string,
  context?: {
    actor?: { type: 'user' | 'system'; id?: string | null; role?: string | null };
    overrideRequested?: boolean;
    overrideReason?: string | null;
  }
) {
  const count = await withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const countResult = await client.query<CycleCountRow>(
      'SELECT * FROM cycle_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (countResult.rowCount === 0) {
      throw new Error('COUNT_NOT_FOUND');
    }
    const cycleCount = countResult.rows[0];
    if (cycleCount.status === 'posted') {
      throw new Error('COUNT_ALREADY_POSTED');
    }
    if (cycleCount.status === 'canceled') {
      throw new Error('COUNT_CANCELED');
    }
    if (cycleCount.posted_at) {
      throw new Error('COUNT_ALREADY_POSTED');
    }

    const linesResult = await client.query<CycleCountLineRow>(
      'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 AND tenant_id = $2 ORDER BY line_number ASC FOR UPDATE',
      [id, tenantId]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('COUNT_NO_LINES');
    }

    const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
    const systemMap = await loadSystemOnHandForLocation(
      tenantId,
      cycleCount.location_id,
      cycleCount.counted_at,
      items,
      client
    );

    const deltas = linesResult.rows.map((line) => {
      const countedQty = roundQuantity(toNumber(line.counted_quantity));
      const systemQty = systemMap.get(makeOnHandKey(line.item_id, line.uom)) ?? 0;
      return {
        line,
        countedQty,
        systemQty,
        variance: roundQuantity(countedQty - systemQty)
      };
    });

    const missingReason = deltas.find(
      (delta) => delta.variance !== 0 && !delta.line.reason_code
    );
    if (missingReason) {
      throw new Error('COUNT_REASON_REQUIRED');
    }

    const negativeLines = deltas
      .filter((delta) => delta.variance < 0)
      .map((delta) => ({
        itemId: delta.line.item_id,
        locationId: cycleCount.location_id,
        uom: delta.line.uom,
        quantityToConsume: roundQuantity(Math.abs(delta.variance))
      }));
    const validation = negativeLines.length
      ? await validateSufficientStock(tenantId, new Date(cycleCount.counted_at), negativeLines, {
          actorId: context?.actor?.id ?? null,
          actorRole: context?.actor?.role ?? null,
          overrideRequested: context?.overrideRequested,
          overrideReason: context?.overrideReason ?? null
        })
      : {};

    const adjustmentId = uuidv4();
    await client.query(
      `INSERT INTO inventory_adjustments (
          id, tenant_id, status, occurred_at, notes, created_at, updated_at
       ) VALUES ($1, $2, 'draft', $3, $4, $5, $5)`,
      [adjustmentId, tenantId, cycleCount.counted_at, cycleCount.notes ?? null, now]
    );

    const nonZeroDeltas = deltas.filter((delta) => delta.variance !== 0);
    for (const delta of nonZeroDeltas) {
      await client.query(
        `INSERT INTO inventory_adjustment_lines (
            id, tenant_id, inventory_adjustment_id, line_number, item_id, location_id, uom, quantity_delta, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          uuidv4(),
          tenantId,
          adjustmentId,
          delta.line.line_number,
          delta.line.item_id,
          cycleCount.location_id,
          delta.line.uom,
          delta.variance,
          delta.line.reason_code,
          delta.line.notes ?? `Cycle count ${id} line ${delta.line.line_number}`
        ]
      );
    }

    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, tenant_id, movement_type, status, external_ref, occurred_at, posted_at, notes, metadata, created_at, updated_at
       ) VALUES ($1, $2, 'adjustment', 'posted', $3, $4, $5, $6, $7, $5, $5)`,
      [
        movementId,
        tenantId,
        `inventory_adjustment:${adjustmentId}`,
        cycleCount.counted_at,
        now,
        cycleCount.notes ?? null,
        validation.overrideMetadata ?? null
      ]
    );

    for (const delta of deltas) {
      await client.query(
        `UPDATE cycle_count_lines
            SET system_quantity = $1,
                variance_quantity = $2
         WHERE id = $3 AND tenant_id = $4`,
        [delta.systemQty, delta.variance, delta.line.id, tenantId]
      );

      if (delta.variance !== 0) {
        // Calculate cost for cycle count adjustment
        const costData = await calculateMovementCost(tenantId, delta.line.item_id, delta.variance, client);
        
        // Handle cost layers for count adjustment
        if (delta.variance > 0) {
          // Positive variance - create new cost layer
          try {
            await createCostLayer({
              tenant_id: tenantId,
              item_id: delta.line.item_id,
              location_id: cycleCount.location_id,
              uom: delta.line.uom,
              quantity: delta.variance,
              unit_cost: costData.unitCost || 0,
              source_type: 'adjustment',
              source_document_id: id,
              movement_id: movementId,
              notes: `Cycle count adjustment - found more than expected`
            });
          } catch (err) {
            console.warn('Failed to create cost layer for count adjustment:', err);
          }
        } else {
          // Negative variance - consume from cost layers
          try {
            await consumeCostLayers({
              tenant_id: tenantId,
              item_id: delta.line.item_id,
              location_id: cycleCount.location_id,
              quantity: Math.abs(delta.variance),
              consumption_type: 'adjustment',
              consumption_document_id: id,
              movement_id: movementId,
              notes: `Cycle count adjustment - found less than expected`
            });
          } catch (err) {
            console.warn('Failed to consume cost layers for count adjustment:', err);
          }
        }
        
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, tenant_id, movement_id, item_id, location_id, quantity_delta, uom, unit_cost, extended_cost, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            uuidv4(),
            tenantId,
            movementId,
            delta.line.item_id,
            cycleCount.location_id,
            delta.variance,
            delta.line.uom,
            costData.unitCost,
            costData.extendedCost,
            delta.line.reason_code,
            delta.line.notes ?? `Cycle count ${id} line ${delta.line.line_number}`
          ]
        );
      }
    }

    await client.query(
      `UPDATE inventory_adjustments
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [movementId, now, adjustmentId, tenantId]
    );

    await client.query(
      `UPDATE cycle_counts
          SET status = 'posted',
              inventory_adjustment_id = $1,
              inventory_movement_id = $2,
              posted_at = $3,
              updated_at = $3
       WHERE id = $4 AND tenant_id = $5`,
      [adjustmentId, movementId, now, id, tenantId]
    );

    if (validation.overrideMetadata && context?.actor) {
      await recordAuditLog(
        {
          tenantId,
          actorType: context.actor.type,
          actorId: context.actor.id ?? null,
          action: 'negative_override',
          entityType: 'inventory_movement',
          entityId: movementId,
          occurredAt: now,
          metadata: {
            reason: validation.overrideMetadata.override_reason ?? null,
            cycleCountId: id,
            lines: negativeLines
          }
        },
        client
      );
    }

    return fetchCycleCountById(tenantId, id, client);
  });

  return count;
}
