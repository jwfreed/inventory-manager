import type { PurchaseOrderStatus } from './types';

export function mapPurchaseOrder(row: any, lines: any[]) {
  return {
    id: row.id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    shipToLocationId: row.ship_to_location_id,
    receivingLocationId: row.receiving_location_id,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    status: row.status as PurchaseOrderStatus,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines
  };
}

export function mapPurchaseOrderLine(line: any) {
  return {
    id: line.id,
    lineNumber: line.line_number,
    itemId: line.item_id,
    itemSku: line.item_sku,
    itemName: line.item_name,
    uom: line.uom,
    quantityOrdered: line.quantity_ordered,
    unitPrice: line.unit_price != null ? Number(line.unit_price) : null,
    notes: line.notes,
    createdAt: line.created_at
  };
}

export function validateReadyForSubmit(input: {
  vendorId?: string | null;
  shipToLocationId?: string | null;
  receivingLocationId?: string | null;
  expectedDate?: string | null;
  lines?: { quantityOrdered?: number | null }[];
}) {
  if (!input.vendorId) throw new Error('PO_SUBMIT_MISSING_VENDOR');
  if (!input.shipToLocationId) throw new Error('PO_SUBMIT_MISSING_SHIP_TO');
  if (!input.receivingLocationId) throw new Error('PO_SUBMIT_MISSING_RECEIVING');
  if (!input.expectedDate) throw new Error('PO_SUBMIT_MISSING_EXPECTED_DATE');
  if (!input.lines || input.lines.length === 0) throw new Error('PO_SUBMIT_MISSING_LINES');
  const hasInvalidQty = input.lines.some((line) => (line.quantityOrdered ?? 0) <= 0);
  if (hasInvalidQty) throw new Error('PO_SUBMIT_INVALID_QUANTITY');
}

export function assertAllowedStatusTransition(current: PurchaseOrderStatus, requested: PurchaseOrderStatus) {
  if (current === requested) return;
  if (current === 'draft' && requested === 'submitted') return;
  if (current === 'submitted' && requested === 'approved') return;
  throw new Error('PO_STATUS_INVALID_TRANSITION');
}
