import { roundQuantity, toNumber } from '../../lib/numbers';
import type {
  InventoryAdjustmentRow,
  InventoryAdjustmentLineRow,
  InventoryAdjustmentSummaryRow,
  InventoryAdjustmentInput,
  NormalizedAdjustmentLine
} from './types';
import { normalizeQuantityByUom } from '../../lib/uom';

export function mapInventoryAdjustment(row: InventoryAdjustmentRow, lines: InventoryAdjustmentLineRow[]) {
  return {
    id: row.id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    correctedFromAdjustmentId: row.corrected_from_adjustment_id ?? null,
    isCorrected: row.is_corrected ?? false,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      lineNumber: line.line_number,
      itemId: line.item_id,
      itemSku: line.item_sku ?? null,
      itemName: line.item_name ?? null,
      locationId: line.location_id,
      locationCode: line.location_code ?? null,
      locationName: line.location_name ?? null,
      uom: line.uom,
      quantityDelta: roundQuantity(toNumber(line.quantity_delta)),
      reasonCode: line.reason_code,
      notes: line.notes,
      createdAt: line.created_at
    }))
  };
}

function parseTotalsByUom(value: unknown) {
  if (!value) return [];
  let parsed: any = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => ({
      uom: String(entry.uom ?? ''),
      quantityDelta: roundQuantity(toNumber(entry.quantityDelta ?? entry.quantity_delta ?? 0))
    }))
    .filter((entry) => entry.uom);
}

export function mapInventoryAdjustmentSummary(row: InventoryAdjustmentSummaryRow) {
  return {
    id: row.id,
    status: row.status,
    occurredAt: row.occurred_at,
    inventoryMovementId: row.inventory_movement_id,
    correctedFromAdjustmentId: row.corrected_from_adjustment_id ?? null,
    isCorrected: row.is_corrected ?? false,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lineCount: row.line_count !== undefined && row.line_count !== null ? Number(row.line_count) : 0,
    totalsByUom: parseTotalsByUom(row.totals_by_uom)
  };
}

export function normalizeAdjustmentLines(data: InventoryAdjustmentInput): NormalizedAdjustmentLine[] {
  const lineNumbers = new Set<number>();
  return data.lines.map((line, index) => {
    const lineNumber = line.lineNumber ?? index + 1;
    if (lineNumbers.has(lineNumber)) {
      throw new Error('ADJUSTMENT_DUPLICATE_LINE');
    }
    const normalized = normalizeQuantityByUom(line.quantityDelta, line.uom);
    lineNumbers.add(lineNumber);
    return {
      lineNumber,
      itemId: line.itemId,
      locationId: line.locationId,
      uom: normalized.uom,
      quantityDelta: normalized.quantity,
      reasonCode: line.reasonCode,
      notes: line.notes ?? null
    };
  });
}
