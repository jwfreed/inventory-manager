import { roundQuantity, toNumber } from '../../lib/numbers';

export type ReceiptInputLine = {
  purchaseOrderLineId: string;
  uom: string;
  quantityReceived: number;
  unitCost?: number | null;
  discrepancyReason?: string | null;
  discrepancyNotes?: string | null;
  lotCode?: string | null;
  serialNumbers?: string[] | null;
  overReceiptApproved?: boolean;
};

export type ReceiptInput = {
  purchaseOrderId: string;
  receivedAt: string;
  receivedToLocationId?: string | null;
  externalRef?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  lines: ReceiptInputLine[];
};

export type PurchaseOrderReceiptInput = ReceiptInput;

export type NormalizedReceiptLine = {
  purchaseOrderLineId: string;
  uom: string;
  quantityReceived: number;
  unitCost: number | null;
  discrepancyReason: string | null;
  discrepancyNotes: string | null;
  lotCode: string | null;
  serialNumbers: string[] | null;
  overReceiptApproved: boolean;
};

export type NormalizedReceiptInput = {
  purchaseOrderId: string;
  receivedAt: string;
  receivedToLocationId: string | null;
  externalRef: string | null;
  notes: string | null;
  idempotencyKey: string | null;
  lines: NormalizedReceiptLine[];
};

export function normalizeOptionalIdempotencyKey(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeReceiptRequest(data: ReceiptInput): NormalizedReceiptInput {
  return {
    purchaseOrderId: data.purchaseOrderId,
    receivedAt: data.receivedAt,
    receivedToLocationId: data.receivedToLocationId ?? null,
    externalRef: data.externalRef ?? null,
    notes: data.notes ?? null,
    idempotencyKey: normalizeOptionalIdempotencyKey(data.idempotencyKey ?? null),
    lines: data.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      uom: line.uom,
      quantityReceived: roundQuantity(toNumber(line.quantityReceived)),
      unitCost: line.unitCost ?? null,
      discrepancyReason: line.discrepancyReason ?? null,
      discrepancyNotes: line.discrepancyNotes ?? null,
      lotCode: line.lotCode ?? null,
      serialNumbers: line.serialNumbers ?? null,
      overReceiptApproved: line.overReceiptApproved ?? false
    }))
  };
}

export function normalizeReceiptCreateInput(data: PurchaseOrderReceiptInput): NormalizedReceiptInput {
  return normalizeReceiptRequest(data);
}

export function getUniqueReceiptPurchaseOrderLineIds(
  data: Pick<NormalizedReceiptInput, 'lines'>
): string[] {
  return Array.from(new Set(data.lines.map((line) => line.purchaseOrderLineId)));
}

export function normalizeReceiptRequestForHash(data: ReceiptInput): Record<string, unknown> {
  const normalized = normalizeReceiptRequest(data);
  const lines = [...normalized.lines]
    .map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      uom: line.uom,
      quantityReceived: line.quantityReceived,
      unitCost: line.unitCost,
      discrepancyReason: line.discrepancyReason,
      discrepancyNotes: line.discrepancyNotes,
      lotCode: line.lotCode,
      serialNumbers: line.serialNumbers,
      overReceiptApproved: line.overReceiptApproved
    }))
    .sort((left, right) => left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId));
  return {
    purchaseOrderId: normalized.purchaseOrderId,
    receivedAt: normalized.receivedAt,
    receivedToLocationId: normalized.receivedToLocationId,
    externalRef: normalized.externalRef,
    notes: normalized.notes,
    lines
  };
}
