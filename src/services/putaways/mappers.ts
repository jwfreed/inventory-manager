import type { PutawayLineRow, PutawayRow } from './types';
import { roundQuantity, toNumber } from '../../lib/numbers';
import {
  calculatePutawayAvailability,
  defaultBreakdown,
  type ReceiptLineContext
} from '../inbound/receivingAggregations';

export function mapPutawayLine(
  line: PutawayLineRow,
  context: ReceiptLineContext,
  qc: ReturnType<typeof defaultBreakdown>,
  totals: { posted: number; pending: number }
) {
  const plannedQty = roundQuantity(toNumber(line.quantity_planned ?? line.quantity_moved ?? 0));
  const movedQty = line.quantity_moved ? roundQuantity(toNumber(line.quantity_moved)) : null;
  const availability = calculatePutawayAvailability(context, qc, totals);
  return {
    id: line.id,
    lineNumber: line.line_number,
    purchaseOrderReceiptLineId: line.purchase_order_receipt_line_id,
    itemId: line.item_id,
    uom: line.uom,
    quantityPlanned: plannedQty,
    quantityMoved: movedQty,
    fromLocationId: line.from_location_id,
    toLocationId: line.to_location_id,
    inventoryMovementId: line.inventory_movement_id,
    status: line.status,
    notes: line.notes,
    createdAt: line.created_at,
    updatedAt: line.updated_at,
    qcBreakdown: qc,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning
  };
}

export function mapPutaway(
  row: PutawayRow,
  lines: PutawayLineRow[],
  contexts: Map<string, ReceiptLineContext>,
  qcMap: Map<string, ReturnType<typeof defaultBreakdown>>,
  totalsMap: Map<string, { posted: number; pending: number }>
) {
  return {
    id: row.id,
    status: row.status,
    sourceType: row.source_type,
    purchaseOrderReceiptId: row.purchase_order_receipt_id,
    inventoryMovementId: row.inventory_movement_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map((line) => {
      const context = contexts.get(line.purchase_order_receipt_line_id);
      const qc = qcMap.get(line.purchase_order_receipt_line_id) ?? defaultBreakdown();
      const totals = totalsMap.get(line.purchase_order_receipt_line_id) ?? { posted: 0, pending: 0 };
      if (!context) {
        throw new Error('Missing receipt line context for putaway line');
      }
      return mapPutawayLine(line, context, qc, totals);
    })
  };
}
