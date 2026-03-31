import { roundQuantity } from '../../lib/numbers';
import type { NormalizedReceiptInput, NormalizedReceiptLine } from './receiptNormalization';

export const RECEIPT_STATUS_EPSILON = 1e-6;

export type ReceiptPurchaseOrderSnapshot = {
  status: string;
  shipToLocationId: string | null;
  receivingLocationId: string | null;
};

export type PurchaseOrderReceiptPolicyRow = {
  status: string;
  ship_to_location_id: string | null;
  receiving_location_id: string | null;
};

export type ReceiptPurchaseOrderLineSnapshot = {
  purchase_order_id: string;
  item_id: string;
  uom: string;
  quantity_ordered: number;
  unit_price: number | null;
  line_status: string;
  over_receipt_tolerance_pct: number;
  requires_lot: boolean;
  requires_serial: boolean;
  requires_qc: boolean;
};

export type PurchaseOrderLinePolicyRow = ReceiptPurchaseOrderLineSnapshot;

export function assertUniqueReceiptPurchaseOrderLines(
  lines: Array<Pick<NormalizedReceiptLine, 'purchaseOrderLineId'>>
) {
  const uniqueLineIds = new Set(lines.map((line) => line.purchaseOrderLineId));
  if (uniqueLineIds.size !== lines.length) {
    throw new Error('RECEIPT_DUPLICATE_PO_LINE');
  }
}

export function assertNoDuplicateReceiptPurchaseOrderLines(uniqueLineIds: string[], expectedLineCount: number) {
  if (uniqueLineIds.length !== expectedLineCount) {
    throw new Error('RECEIPT_DUPLICATE_PO_LINE');
  }
}

export function assertReceiptPurchaseOrderReceivable(
  purchaseOrder: Pick<PurchaseOrderReceiptPolicyRow, 'status'>
) {
  if (['received', 'closed', 'canceled'].includes(purchaseOrder.status)) {
    throw new Error('RECEIPT_PO_CLOSED');
  }
  if (purchaseOrder.status === 'draft') {
    throw new Error('RECEIPT_PO_NOT_APPROVED');
  }
}

export function assertReceiptCanBeCreated(params: {
  receipt: Pick<NormalizedReceiptInput, 'purchaseOrderId' | 'lines'>;
  purchaseOrder: ReceiptPurchaseOrderSnapshot;
  poLines: Map<string, ReceiptPurchaseOrderLineSnapshot>;
  receivedQuantities: Map<string, number>;
}) {
  const { receipt, purchaseOrder, poLines, receivedQuantities } = params;
  if (['received', 'closed', 'canceled'].includes(purchaseOrder.status)) {
    throw new Error('RECEIPT_PO_CLOSED');
  }
  if (purchaseOrder.status === 'draft') {
    throw new Error('RECEIPT_PO_NOT_APPROVED');
  }

  for (const line of receipt.lines) {
    const poLine = poLines.get(line.purchaseOrderLineId);
    if (!poLine) {
      throw new Error('RECEIPT_LINE_INVALID_REFERENCE');
    }
    if (poLine.purchase_order_id !== receipt.purchaseOrderId) {
      throw new Error('RECEIPT_LINES_WRONG_PO');
    }
    if (poLine.uom !== line.uom) {
      throw new Error('RECEIPT_LINE_UOM_MISMATCH');
    }
    if (poLine.line_status === 'closed_short' || poLine.line_status === 'cancelled' || poLine.line_status === 'complete') {
      throw new Error('RECEIPT_PO_LINE_CLOSED');
    }

    const expectedQty = roundQuantity(poLine.quantity_ordered ?? 0);
    const alreadyReceivedQty = receivedQuantities.get(line.purchaseOrderLineId) ?? 0;
    const projectedTotal = roundQuantity(alreadyReceivedQty + line.quantityReceived);

    if (poLine.requires_lot && !line.lotCode) {
      throw new Error('RECEIPT_LOT_REQUIRED');
    }
    if (poLine.requires_serial) {
      if (!line.serialNumbers || line.serialNumbers.length === 0) {
        throw new Error('RECEIPT_SERIAL_REQUIRED');
      }
      if (!Number.isInteger(line.quantityReceived)) {
        throw new Error('RECEIPT_SERIAL_QTY_MUST_BE_INTEGER');
      }
      const uniqueSerials = new Set(line.serialNumbers);
      if (uniqueSerials.size !== line.serialNumbers.length) {
        throw new Error('RECEIPT_SERIAL_DUPLICATE');
      }
      if (line.serialNumbers.length !== line.quantityReceived) {
        throw new Error('RECEIPT_SERIAL_COUNT_MISMATCH');
      }
    }

    if (projectedTotal - expectedQty > RECEIPT_STATUS_EPSILON) {
      if (!line.overReceiptApproved) {
        throw new Error('RECEIPT_OVERRECEIPT_NOT_APPROVED');
      }
      if (line.discrepancyReason !== 'over') {
        throw new Error('RECEIPT_OVERRECEIPT_REASON_REQUIRED');
      }
    }
  }
}

export function assertReceiptLinesAgainstPolicy(params: {
  data: Pick<NormalizedReceiptInput, 'purchaseOrderId' | 'lines'>;
  poLineMap: Map<string, PurchaseOrderLinePolicyRow>;
  receivedMap: Map<string, number>;
}) {
  assertReceiptCanBeCreated({
    receipt: {
      purchaseOrderId: params.data.purchaseOrderId,
      lines: params.data.lines
    },
    purchaseOrder: {
      status: 'approved',
      shipToLocationId: null,
      receivingLocationId: null
    },
    poLines: params.poLineMap,
    receivedQuantities: params.receivedMap
  });
}

export function assertReceiptLocationContext(params: {
  receivedToLocationId: string | null;
  qaLocationId: string | null;
}) {
  if (!params.receivedToLocationId) {
    throw new Error('RECEIPT_RECEIVING_LOCATION_REQUIRED');
  }
  if (!params.qaLocationId) {
    throw new Error('QA_LOCATION_REQUIRED');
  }
}

export function assertReceiptPostingQuantityIntegrity(params: {
  receiptLines: Array<Pick<NormalizedReceiptLine, 'purchaseOrderLineId' | 'quantityReceived'>>;
  plannedLines: Array<{ purchaseOrderLineId: string; receivedQty: number }>;
}) {
  const expectedByLine = new Map(
    params.receiptLines.map((line) => [line.purchaseOrderLineId, roundQuantity(line.quantityReceived)])
  );
  const plannedByLine = new Map(
    params.plannedLines.map((line) => [line.purchaseOrderLineId, roundQuantity(line.receivedQty)])
  );

  if (expectedByLine.size !== plannedByLine.size) {
    throw new Error('RECEIPT_QUANTITY_INTEGRITY_VIOLATION');
  }

  for (const [purchaseOrderLineId, expectedQty] of expectedByLine.entries()) {
    const plannedQty = plannedByLine.get(purchaseOrderLineId);
    if (plannedQty == null || Math.abs(plannedQty - expectedQty) > RECEIPT_STATUS_EPSILON) {
      throw new Error('RECEIPT_QUANTITY_INTEGRITY_VIOLATION');
    }
  }
}
