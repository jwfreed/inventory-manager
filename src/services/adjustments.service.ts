import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction } from '../db';
import { inventoryAdjustmentSchema } from '../schemas/adjustments.schema';

type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;

type InventoryAdjustmentRow = {
  id: string;
  status: string;
  occurred_at: string;
  inventory_movement_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type InventoryAdjustmentLineRow = {
  id: string;
  inventory_adjustment_id: string;
  line_number: number;
  item_id: string;
  location_id: string;
  uom: string;
  quantity_delta: string | number;
  reason_code: string;
  notes: string | null;
  created_at: string;
};

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

function mapInventoryAdjustment(row: InventoryAdjustmentRow, lines: InventoryAdjustmentLineRow[]) {
  return {
    id: row.id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      locationId: line.location_id,
      uom: line.uom,
      quantityDelta: roundQuantity(toNumber(line.quantity_delta)),
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

async function fetchInventoryAdjustmentById(id: string, client?: PoolClient) {
  const executor = client ?? pool;
  const adjustmentResult = await executor.query<InventoryAdjustmentRow>('SELECT * FROM inventory_adjustments WHERE id = $1', [
    id
  ]);
  if (adjustmentResult.rowCount === 0) {
    return null;
  }
  const linesResult = await executor.query<InventoryAdjustmentLineRow>(
    'SELECT * FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 ORDER BY line_number ASC',
    [id]
  );
  return mapInventoryAdjustment(adjustmentResult.rows[0], linesResult.rows);
}

function normalizeAdjustmentLines(data: InventoryAdjustmentInput) {
  const lineNumbers = new Set<number>();
  return data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('ADJUSTMENT_DUPLICATE_LINE');
    }
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.uom,
      quantityDelta: roundQuantity(line.quantityDelta),
      reasonCode: line.reasonCode,
      notes: line.notes ?? null
    };
  });
}

export async function createInventoryAdjustment(data: InventoryAdjustmentInput) {
  const normalizedLines = normalizeAdjustmentLines(data);
  const now = new Date();
  const adjustmentId = uuidv4();

  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `INSERT INTO inventory_adjustments (
          id, status, occurred_at, notes, created_at, updated_at
       ) VALUES ($1, 'draft', $2, $3, $4, $4)`,
      [adjustmentId, new Date(data.occurredAt), data.notes ?? null, now]
    );

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO inventory_adjustment_lines (
            id, inventory_adjustment_id, line_number, item_id, location_id, uom, quantity_delta, reason_code, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(),
          adjustmentId,
          line.lineNumber,
          line.itemId,
          line.locationId,
          line.uom,
          line.quantityDelta,
          line.reasonCode,
          line.notes
        ]
      );
    }
  });

  const adjustment = await fetchInventoryAdjustmentById(adjustmentId);
  if (!adjustment) {
    throw new Error('ADJUSTMENT_NOT_FOUND');
  }
  return adjustment;
}

export async function getInventoryAdjustment(id: string) {
  return fetchInventoryAdjustmentById(id);
}

export async function postInventoryAdjustment(id: string) {
  const adjustment = await withTransaction(async (client: PoolClient) => {
    const now = new Date();
    const adjustmentResult = await client.query<InventoryAdjustmentRow>('SELECT * FROM inventory_adjustments WHERE id = $1 FOR UPDATE', [
      id
    ]);
    if (adjustmentResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NOT_FOUND');
    }
    const adjustmentRow = adjustmentResult.rows[0];
    if (adjustmentRow.status === 'posted') {
      throw new Error('ADJUSTMENT_ALREADY_POSTED');
    }
    if (adjustmentRow.status === 'canceled') {
      throw new Error('ADJUSTMENT_CANCELED');
    }

    const linesResult = await client.query<InventoryAdjustmentLineRow>(
      'SELECT * FROM inventory_adjustment_lines WHERE inventory_adjustment_id = $1 ORDER BY line_number ASC',
      [id]
    );
    if (linesResult.rowCount === 0) {
      throw new Error('ADJUSTMENT_NO_LINES');
    }

    const movementId = uuidv4();
    await client.query(
      `INSERT INTO inventory_movements (
          id, movement_type, status, external_ref, occurred_at, posted_at, notes, created_at, updated_at
       ) VALUES ($1, 'adjustment', 'posted', $2, $3, $4, $5, $4, $4)`,
      [movementId, `inventory_adjustment:${id}`, adjustmentRow.occurred_at, now, adjustmentRow.notes ?? null]
    );

    for (const line of linesResult.rows) {
      const qty = roundQuantity(toNumber(line.quantity_delta));
      if (qty === 0) {
        throw new Error('ADJUSTMENT_LINE_ZERO');
      }
      await client.query(
        `INSERT INTO inventory_movement_lines (
            id, movement_id, item_id, location_id, quantity_delta, uom, reason_code, line_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv4(),
          movementId,
          line.item_id,
          line.location_id,
          qty,
          line.uom,
          line.reason_code,
          line.notes ?? `Adjustment ${id} line ${line.line_number}`
        ]
      );
    }

    await client.query(
      `UPDATE inventory_adjustments
          SET status = 'posted',
              inventory_movement_id = $1,
              updated_at = $2
       WHERE id = $3`,
      [movementId, now, id]
    );

    return fetchInventoryAdjustmentById(id, client);
  });

  return adjustment;
}
