import { createHash } from 'crypto';
import { roundQuantity } from '../lib/numbers';

export type NormalizedBatchConsumeLine = {
  componentItemId: string;
  fromLocationId: string;
  uom: string;
  quantity: number;
  reasonCode: string | null;
  notes: string | null;
};

export type NormalizedBatchProduceLine = {
  outputItemId: string;
  toLocationId: string;
  uom: string;
  quantity: number;
  packSize: number | null;
  reasonCode: string | null;
  notes: string | null;
};

function normalizedBatchConsumeSortKey(line: NormalizedBatchConsumeLine) {
  return [
    line.componentItemId,
    line.fromLocationId,
    line.uom,
    line.quantity.toString(),
    line.reasonCode ?? '',
    line.notes ?? ''
  ].join('|');
}

function normalizedBatchProduceSortKey(line: NormalizedBatchProduceLine) {
  return [
    line.outputItemId,
    line.toLocationId,
    line.uom,
    line.quantity.toString(),
    line.packSize?.toString() ?? '',
    line.reasonCode ?? '',
    line.notes ?? ''
  ].join('|');
}

export function normalizeBatchRequestPayload(params: {
  workOrderId: string;
  occurredAt: Date;
  notes?: string | null;
  overrideNegative?: boolean;
  overrideReason?: string | null;
  consumeLines: NormalizedBatchConsumeLine[];
  produceLines: NormalizedBatchProduceLine[];
}) {
  const normalizedConsumeLines = [...params.consumeLines]
    .map((line) => ({
      componentItemId: line.componentItemId,
      fromLocationId: line.fromLocationId,
      uom: line.uom,
      quantity: roundQuantity(line.quantity),
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    }))
    .sort((a, b) => normalizedBatchConsumeSortKey(a).localeCompare(normalizedBatchConsumeSortKey(b)));
  const normalizedProduceLines = [...params.produceLines]
    .map((line) => ({
      outputItemId: line.outputItemId,
      toLocationId: line.toLocationId,
      uom: line.uom,
      quantity: roundQuantity(line.quantity),
      packSize: line.packSize !== null ? roundQuantity(line.packSize) : null,
      reasonCode: line.reasonCode ?? null,
      notes: line.notes ?? null
    }))
    .sort((a, b) => normalizedBatchProduceSortKey(a).localeCompare(normalizedBatchProduceSortKey(b)));

  return {
    workOrderId: params.workOrderId,
    occurredAt: params.occurredAt.toISOString(),
    notes: params.notes ?? null,
    overrideNegative: params.overrideNegative ?? false,
    overrideReason: params.overrideReason ?? null,
    consumeLines: normalizedConsumeLines,
    produceLines: normalizedProduceLines
  };
}

export function hashNormalizedBatchRequest(payload: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function normalizedOptionalIdempotencyKey(key?: string | null) {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveReportProductionIdempotencyKey(
  workOrderId: string,
  data: { idempotencyKey?: string | null; clientRequestId?: string | null },
  options?: { idempotencyKey?: string | null }
) {
  const explicit = normalizedOptionalIdempotencyKey(options?.idempotencyKey ?? data.idempotencyKey ?? null);
  if (explicit) {
    return explicit;
  }
  const clientRequestId = normalizedOptionalIdempotencyKey(data.clientRequestId ?? null);
  if (!clientRequestId) {
    return null;
  }
  return `wo-report:${workOrderId}:${clientRequestId}`;
}

export function assertVoidReason(reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('WO_VOID_REASON_REQUIRED');
  }
  return trimmed;
}

export function assertScrapReasonCode(reasonCode: string) {
  const trimmed = reasonCode.trim();
  if (!trimmed) {
    throw new Error('WO_SCRAP_REASON_REQUIRED');
  }
  return trimmed;
}
