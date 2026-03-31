export type ReceiptResolvedLocationContext = {
  receivingLocationId: string;
  qaLocationId: string;
  warehouseId: string;
};

export function assertReceiptLocationResolution(params: {
  receivingLocationId: string | null;
  qaLocationId: string | null;
  warehouseId: string | null;
}): ReceiptResolvedLocationContext {
  if (!params.receivingLocationId) {
    throw new Error('RECEIPT_RECEIVING_LOCATION_REQUIRED');
  }
  if (!params.qaLocationId) {
    throw new Error('QA_LOCATION_REQUIRED');
  }
  if (!params.warehouseId) {
    throw new Error('WAREHOUSE_ID_REQUIRED');
  }
  return {
    receivingLocationId: params.receivingLocationId,
    qaLocationId: params.qaLocationId,
    warehouseId: params.warehouseId
  };
}

export function assertReceiptLineLocationsResolved(
  lines: Array<{ purchaseOrderLineId: string }>,
  context: ReceiptResolvedLocationContext
) {
  if (!context.receivingLocationId || !context.qaLocationId || !context.warehouseId) {
    throw new Error('RECEIPT_LOCATION_CONTEXT_UNRESOLVED');
  }
  for (const line of lines) {
    if (!line.purchaseOrderLineId) {
      throw new Error('RECEIPT_LINE_INVALID_REFERENCE');
    }
  }
}
