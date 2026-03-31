import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { persistInventoryMovement } from '../../domains/inventory';
import { createReceiptCostLayerOnce } from '../../services/costLayers.service';

export type ReceiptPostingCanonicalFields = {
  quantityDeltaCanonical: number;
  canonicalUom: string;
  quantityDeltaEntered: number;
  uomEntered: string;
  uomDimension: string;
};

export type PlannedReceiptPostingLine = {
  receiptLineId: string;
  purchaseOrderLineId: string;
  itemId: string;
  receivedQty: number;
  expectedQty: number;
  unitCost: number | null;
  canonicalFields: ReceiptPostingCanonicalFields;
  costData: {
    unitCost: number | null;
    extendedCost: number | null;
  };
  discrepancyReason: string | null;
  discrepancyNotes: string | null;
  lotCode: string | null;
  serialNumbers: string[] | null;
  overReceiptApproved: boolean;
};

export type PlannedReceiptLine = PlannedReceiptPostingLine;

export function createPlannedReceiptLineId() {
  return uuidv4();
}

export async function postReceiptInventoryMovement(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  warehouseId: string;
  locationId: string;
  occurredAt: Date;
  createdAt?: Date;
  now?: Date;
  idempotencyKey?: string | null;
  movementIdempotencyKey?: string | null;
  lines?: PlannedReceiptPostingLine[];
  plannedReceiptLines?: PlannedReceiptPostingLine[];
}) {
  const createdAt = params.createdAt ?? params.now ?? new Date();
  const lines = params.lines ?? params.plannedReceiptLines ?? [];
  return persistInventoryMovement(params.client, {
    tenantId: params.tenantId,
    movementType: 'receive',
    status: 'posted',
    externalRef: `po_receipt:${params.receiptId}`,
    sourceType: 'po_receipt',
    sourceId: params.receiptId,
    idempotencyKey: params.idempotencyKey ?? params.movementIdempotencyKey ?? null,
    occurredAt: params.occurredAt,
    postedAt: params.occurredAt,
    notes: `PO receipt ${params.receiptId}`,
    createdAt,
    updatedAt: createdAt,
    lines: lines.map((line) => ({
      warehouseId: params.warehouseId,
      sourceLineId: line.receiptLineId,
      itemId: line.itemId,
      locationId: params.locationId,
      quantityDelta: line.canonicalFields.quantityDeltaCanonical,
      uom: line.canonicalFields.canonicalUom,
      quantityDeltaEntered: line.canonicalFields.quantityDeltaEntered,
      uomEntered: line.canonicalFields.uomEntered,
      quantityDeltaCanonical: line.canonicalFields.quantityDeltaCanonical,
      canonicalUom: line.canonicalFields.canonicalUom,
      uomDimension: line.canonicalFields.uomDimension,
      unitCost: line.costData.unitCost,
      extendedCost: line.costData.extendedCost,
      reasonCode: 'receipt',
      lineNotes: `PO receipt line ${line.receiptLineId}`,
      createdAt
    }))
  });
}

export async function insertPostedReceipt(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  purchaseOrderId: string;
  occurredAt: Date;
  receivedToLocationId: string;
  movementId: string;
  externalRef: string | null;
  notes: string | null;
  idempotencyKey: string | null;
  receiptNumber: string;
}) {
  await params.client.query(
    `INSERT INTO purchase_order_receipts (
        id, tenant_id, purchase_order_id, status, received_at, received_to_location_id,
        inventory_movement_id, external_ref, notes, idempotency_key, receipt_number
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.receiptId,
      params.tenantId,
      params.purchaseOrderId,
      'posted',
      params.occurredAt,
      params.receivedToLocationId,
      params.movementId,
      params.externalRef,
      params.notes,
      params.idempotencyKey,
      params.receiptNumber
    ]
  );
}

export async function insertPurchaseOrderReceipt(params: {
  client: PoolClient;
  receiptId: string;
  tenantId: string;
  purchaseOrderId: string;
  occurredAt: Date;
  receivedToLocationId: string;
  inventoryMovementId: string;
  externalRef: string | null;
  notes: string | null;
  idempotencyKey: string | null;
  receiptNumber: string;
}) {
  return insertPostedReceipt({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    purchaseOrderId: params.purchaseOrderId,
    occurredAt: params.occurredAt,
    receivedToLocationId: params.receivedToLocationId,
    movementId: params.inventoryMovementId,
    externalRef: params.externalRef,
    notes: params.notes,
    idempotencyKey: params.idempotencyKey,
    receiptNumber: params.receiptNumber
  });
}

export async function insertPostedReceiptLine(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  line: PlannedReceiptPostingLine;
}) {
  await params.client.query(
    `INSERT INTO purchase_order_receipt_lines (
        id, tenant_id, purchase_order_receipt_id, purchase_order_line_id, uom,
        quantity_received, expected_quantity, unit_cost, discrepancy_reason, discrepancy_notes,
        lot_code, serial_numbers, over_receipt_approved
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      params.line.receiptLineId,
      params.tenantId,
      params.receiptId,
      params.line.purchaseOrderLineId,
      params.line.canonicalFields.uomEntered,
      params.line.receivedQty,
      params.line.expectedQty,
      params.line.unitCost,
      params.line.discrepancyReason,
      params.line.discrepancyNotes,
      params.line.lotCode,
      params.line.serialNumbers ?? null,
      params.line.overReceiptApproved
    ]
  );
}

export async function insertPurchaseOrderReceiptLines(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  plannedReceiptLines: PlannedReceiptPostingLine[];
}) {
  for (const line of params.plannedReceiptLines) {
    await insertPostedReceiptLine({
      client: params.client,
      tenantId: params.tenantId,
      receiptId: params.receiptId,
      line
    });
  }
}

export async function insertReceiptCostLayer(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  qaLocationId: string;
  occurredAt: Date;
  line: PlannedReceiptPostingLine;
}) {
  if (params.line.unitCost == null) {
    return null;
  }
  return createReceiptCostLayerOnce({
    tenant_id: params.tenantId,
    item_id: params.line.itemId,
    location_id: params.qaLocationId,
    uom: params.line.canonicalFields.canonicalUom,
    quantity: params.line.canonicalFields.quantityDeltaCanonical,
    unit_cost: params.line.unitCost,
    source_type: 'receipt',
    source_document_id: params.line.receiptLineId,
    movement_id: params.movementId,
    layer_date: params.occurredAt,
    notes: `Receipt from PO line ${params.line.purchaseOrderLineId}`,
    client: params.client
  });
}

export async function createReceiptCostLayers(params: {
  client: PoolClient;
  tenantId: string;
  movementId: string;
  locationId: string;
  occurredAt: Date;
  plannedReceiptLines: PlannedReceiptPostingLine[];
}) {
  for (const line of params.plannedReceiptLines) {
    await insertReceiptCostLayer({
      client: params.client,
      tenantId: params.tenantId,
      movementId: params.movementId,
      qaLocationId: params.locationId,
      occurredAt: params.occurredAt,
      line
    });
  }
}
