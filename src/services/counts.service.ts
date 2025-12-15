import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction } from '../db';
import { inventoryCountSchema } from '../schemas/counts.schema';

type InventoryCountInput = z.infer<typeof inventoryCountSchema>;

type CycleCountRow = {
  id: string;
  status: string;
  counted_at: string;
  location_id: string;
  notes: string | null;
  inventory_movement_id: string | null;
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
  notes: string | null;
  created_at: string;
};

type OnHandKey = string;

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
}

function roundQuantity(value: number): number {
  return parseFloat(value.toFixed(6));
}

function makeOnHandKey(itemId: string, uom: string): OnHandKey {
  return `${itemId}:${uom}`;
}

async function loadSystemOnHandForLocation(
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
      GROUP BY l.item_id, l.uom`,
    [locationId, countedAt, itemIds]
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
  notes: string | null;
  createdAt: string;
};

type CycleCountSummary = {
  totalAbsVariance: number;
  lineCount: number;
  linesWithVariance: number;
};

function mapCycleCountLines(
  countRow: CycleCountRow,
  lines: CycleCountLineRow[],
  systemMap: Map<OnHandKey, number>
): { lineSummaries: CycleCountLineSummary[]; summary: CycleCountSummary } {
  const lineSummaries = lines.map((line) => {
    const countedQty = roundQuantity(toNumber(line.counted_quantity));
    const systemQty = systemMap.get(makeOnHandKey(line.item_id, line.uom)) ?? 0;
    const variance = roundQuantity(countedQty - systemQty);
    const varianceRatio = countedQty === 0 ? Math.abs(variance) : Math.abs(variance) / countedQty;
    return {
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      uom: line.uom,
      countedQuantity: countedQty,
      systemQuantity: systemQty,
      varianceQuantity: variance,
      varianceRatio: roundQuantity(varianceRatio),
      notes: line.notes,
      createdAt: line.created_at
    };
  });

  const totalAbsVariance = roundQuantity(
    lineSummaries.reduce((sum, line) => sum + Math.abs(line.varianceQuantity), 0)
  );
  const linesWithVariance = lineSummaries.filter((line) => line.varianceQuantity !== 0).length;

  return {
    lineSummaries,
    summary: {
      totalAbsVariance,
      lineCount: lineSummaries.length,
      linesWithVariance
    }
  };
}

function mapCycleCount(row: CycleCountRow, lines: CycleCountLineRow[], systemMap: Map<OnHandKey, number>) {
  const { lineSummaries, summary } = mapCycleCountLines(row, lines, systemMap);
  return {
    id: row.id,
    status: row.status,
    countedAt: row.counted_at,
    locationId: row.location_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lineSummaries,
    summary
  };
}

async function fetchCycleCountById(id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const countResult = await executor.query<CycleCountRow>('SELECT * FROM cycle_counts WHERE id = $1', [id]);
  if (countResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<CycleCountLineRow>(
    'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 ORDER BY line_number ASC',
    [id]
  );
  const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
  const systemMap = await loadSystemOnHandForLocation(
    countResult.rows[0].location_id,
    countResult.rows[0].counted_at,
    items,
    client
  );
  return mapCycleCount(countResult.rows[0], linesResult.rows, systemMap);
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
      notes: line.notes ?? null
    };
  });
}

export async function createInventoryCount(data: InventoryCountInput) {
  const normalizedLines = normalizeCountLines(data);
  const countId = uuidv4();
  const now = new Date();

  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `INSERT INTO cycle_counts (
          id, status, counted_at, location_id, notes, created_at, updated_at
       ) VALUES ($1, 'draft', $2, $3, $4, $5, $5)`,
      [countId, new Date(data.countedAt), data.locationId, data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO cycle_count_lines (
            id, cycle_count_id, line_number, item_id, uom, counted_quantity, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv4(), countId, line.lineNumber, line.itemId, line.uom, line.countedQuantity, line.notes]
      );
    }
  });

  const count = await fetchCycleCountById(countId);
  if (!count) {
    throw new Error('COUNT_NOT_FOUND');
  }
  return count;
}

export async function getInventoryCount(id: string) {
  return fetchCycleCountById(id);
}

export async function postInventoryCount(id: string) {
  const count = await withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const countResult = await client.query<CycleCountRow>('SELECT * FROM cycle_counts WHERE id = $1 FOR UPDATE', [id]);
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

    const linesResult = await client.query<CycleCountLineRow>(
      'SELECT * FROM cycle_count_lines WHERE cycle_count_id = $1 ORDER BY line_number ASC FOR UPDATE',
      [id]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('COUNT_NO_LINES');
    }

    const items = linesResult.rows.map((line) => ({ itemId: line.item_id, uom: line.uom }));
    const systemMap = await loadSystemOnHandForLocation(
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

    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'count', 'posted', $2, $3, $4, $5, $4, $4)`,
      [movementId, `inventory_count:${id}`, cycleCount.counted_at, now, cycleCount.notes ?? null]
    );

    for (const delta of deltas) {
      await client.query(
        `UPDATE cycle_count_lines
            SET system_quantity = $1,
                variance_quantity = $2
         WHERE id = $3`,
        [delta.systemQty, delta.variance, delta.line.id]
      );

      if (delta.variance !== 0) {
        await client.query(
          `INSERT INTO inventory_movement_lines (
              id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
           ) VALUES ($1, $2, $3, $4, $5, $6, 'cycle_count', $7)`,
          [
            uuidv4(),
            movementId,
            delta.line.item_id,
            cycleCount.location_id,
            delta.variance,
            delta.line.uom,
            delta.line.notes ?? `Cycle count ${id} line ${delta.line.line_number}`
          ]
        );
      }
    }

    await client.query(
      `UPDATE cycle_counts
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
       WHERE id = $3`,
      [movementId, now, id]
    );

    return fetchCycleCountById(id, client);
  });

  return count;
}
