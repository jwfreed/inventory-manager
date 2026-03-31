export type ReceiptCloseoutLineFacts = {
  remainingToPutaway: number;
  holdQty: number;
  allocationQuantityMatchesReceipt: boolean;
};

export function buildReceiptCloseoutBlockers(params: {
  lineFacts: ReceiptCloseoutLineFacts[];
  openDiscrepancyCount: number;
}) {
  const reasons = new Set<string>();
  if (params.openDiscrepancyCount > 0) {
    reasons.add('Receipt reconciliation required before closeout.');
  }
  for (const line of params.lineFacts) {
    if (!line.allocationQuantityMatchesReceipt) {
      reasons.add('Receipt allocation total does not match received quantity.');
    }
    if (line.holdQty > 0) {
      reasons.add('QC hold unresolved.');
    }
    if (line.remainingToPutaway > 0) {
      reasons.add('Accepted quantity remains outside available bins.');
    }
  }
  return Array.from(reasons);
}

export function assertReceiptCloseoutAllowed(params: {
  lineFacts: ReceiptCloseoutLineFacts[];
  openDiscrepancyCount: number;
}) {
  const reasons = buildReceiptCloseoutBlockers(params);
  if (reasons.length > 0) {
    const error: any = new Error('RECEIPT_NOT_ELIGIBLE');
    error.reasons = reasons;
    throw error;
  }
}
