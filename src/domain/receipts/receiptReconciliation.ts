import { roundQuantity } from '../../lib/numbers';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';

export type ReceiptPostingTraceLine = {
  receiptLineId: string;
  purchaseOrderLineId: string;
  itemId: string;
  movementSourceLineId: string;
  quantity: number;
  costLayerId: string | null;
};

export function buildReceiptPostingTrace(lines: Array<{
  receiptLineId: string;
  purchaseOrderLineId: string;
  itemId: string;
  quantity: number;
  costLayerId?: string | null;
}>): ReceiptPostingTraceLine[] {
  return lines.map((line) => ({
    receiptLineId: line.receiptLineId,
    purchaseOrderLineId: line.purchaseOrderLineId,
    itemId: line.itemId,
    movementSourceLineId: line.receiptLineId,
    quantity: roundQuantity(line.quantity),
    costLayerId: line.costLayerId ?? null
  }));
}

export function assertReceiptPostingTraceability(lines: ReceiptPostingTraceLine[]) {
  const seenMovementSources = new Set<string>();
  for (const line of lines) {
    if (!line.receiptLineId || !line.purchaseOrderLineId || !line.itemId || !line.movementSourceLineId) {
      throw new Error('RECEIPT_TRACEABILITY_VIOLATION');
    }
    if (seenMovementSources.has(line.movementSourceLineId)) {
      throw new Error('RECEIPT_TRACEABILITY_VIOLATION');
    }
    seenMovementSources.add(line.movementSourceLineId);
  }
}

export function assertReceiptReconciliationIntegrity(params: {
  expectedQtyByReceiptLineId: Map<string, number>;
  traceLines: ReceiptPostingTraceLine[];
}) {
  const postedQtyByReceiptLineId = new Map<string, number>();
  for (const line of params.traceLines) {
    postedQtyByReceiptLineId.set(
      line.receiptLineId,
      roundQuantity((postedQtyByReceiptLineId.get(line.receiptLineId) ?? 0) + line.quantity)
    );
  }

  for (const [receiptLineId, expectedQty] of params.expectedQtyByReceiptLineId.entries()) {
    const postedQty = postedQtyByReceiptLineId.get(receiptLineId) ?? 0;
    if (Math.abs(roundQuantity(expectedQty) - postedQty) > RECEIPT_STATUS_EPSILON) {
      throw new Error('RECEIPT_RECONCILIATION_REQUIRED');
    }
  }
}

export function assertPostingTraceIntegrity(params: {
  expectedQtyByReceiptLineId: Map<string, number>;
  traceLines: ReceiptPostingTraceLine[];
}) {
  return assertReceiptReconciliationIntegrity(params);
}

export type PhysicalCount = {
  receiptLineId: string;
  countedQty: number;
  toleranceQty?: number;
};

export function reconcileReceiptPhysicalCount(params: {
  expectedQty: number;
  count: PhysicalCount;
}) {
  const expectedQty = roundQuantity(params.expectedQty);
  const countedQty = roundQuantity(params.count.countedQty);
  const discrepancyQty = roundQuantity(countedQty - expectedQty);
  const toleranceQty = roundQuantity(params.count.toleranceQty ?? 0);
  return {
    receiptLineId: params.count.receiptLineId,
    expectedQty,
    countedQty,
    discrepancyQty,
    toleranceQty,
    withinTolerance: Math.abs(discrepancyQty) <= toleranceQty + RECEIPT_STATUS_EPSILON
  };
}
