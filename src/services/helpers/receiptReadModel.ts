import { roundQuantity, toNumber } from '../../lib/numbers';
import {
  deriveReceiptLifecycleState,
  RECEIPT_STATES
} from '../../domain/receipts/receiptStateModel';
import {
  calculateAcceptedQuantity,
  calculatePutawayAvailability,
  defaultBreakdown,
  type PutawayTotals,
  type QcBreakdown
} from '../inbound/receivingAggregations';

const STATUS_EPSILON = 1e-6;

export type ReceiptTotals = {
  totalReceived: number;
  totalAccept: number;
  totalHold: number;
  totalReject: number;
  totalAcceptedQty: number;
  putawayPosted: number;
  putawayPending: number;
};

export type ReceiptStatusSummary = {
  workflowStatus: string;
  qcStatus: 'pending' | 'passed' | 'failed';
  putawayStatus: 'not_available' | 'not_started' | 'pending' | 'complete';
  qcEligible: boolean;
  putawayEligible: boolean;
};

function buildQcSummary(lineId: string, breakdownMap: Map<string, QcBreakdown>, quantityReceived: number) {
  const breakdown = breakdownMap.get(lineId) ?? defaultBreakdown();
  const totalQcQuantity = roundQuantity(breakdown.hold + breakdown.accept + breakdown.reject);
  return {
    totalQcQuantity,
    breakdown,
    remainingUninspectedQuantity: roundQuantity(Math.max(0, quantityReceived - totalQcQuantity))
  };
}

export function mapReceiptLine(
  line: any,
  qcBreakdown: Map<string, QcBreakdown>,
  totalsMap: Map<string, PutawayTotals>
) {
  const quantityReceived = roundQuantity(toNumber(line.quantity_received));
  const qc = qcBreakdown.get(line.id) ?? defaultBreakdown();
  const totals = totalsMap.get(line.id) ?? { posted: 0, pending: 0 };
  const acceptedQuantity = calculateAcceptedQuantity(quantityReceived, qc, false);
  const postedQuantity = roundQuantity(totals.posted ?? 0);
  let putawayStatus = 'not_available';
  if (acceptedQuantity > 0) {
    if (postedQuantity <= 0) {
      putawayStatus = 'not_started';
    } else if (postedQuantity + 1e-6 < acceptedQuantity) {
      putawayStatus = 'partial';
    } else {
      putawayStatus = 'complete';
    }
  }
  const availability = calculatePutawayAvailability(
    {
      id: line.id,
      receiptId: line.purchase_order_receipt_id,
      purchaseOrderId: line.purchase_order_id ?? '',
      itemId: line.item_id ?? '',
      uom: line.uom,
      quantityReceived,
      defaultFromLocationId: line.received_to_location_id ?? line.item_default_location_id ?? null
    },
    qc,
    totals
  );
  return {
    id: line.id,
    purchaseOrderReceiptId: line.purchase_order_receipt_id,
    purchaseOrderLineId: line.purchase_order_line_id,
    defaultFromLocationId: line.received_to_location_id ?? line.item_default_location_id ?? null,
    itemId: line.item_id,
    itemSku: line.item_sku ?? null,
    itemName: line.item_name ?? null,
    defaultToLocationId: line.item_default_location_id ?? null,
    uom: line.uom,
    expectedQuantity: roundQuantity(toNumber(line.expected_quantity ?? 0)),
    quantityReceived,
    unitCost: line.unit_cost != null ? Number(line.unit_cost) : null,
    discrepancyReason: line.discrepancy_reason ?? null,
    discrepancyNotes: line.discrepancy_notes ?? null,
    lotCode: line.lot_code ?? null,
    serialNumbers: line.serial_numbers ?? null,
    overReceiptApproved: line.over_receipt_approved ?? false,
    requiresLot: line.requires_lot ?? false,
    requiresSerial: line.requires_serial ?? false,
    requiresQc: line.requires_qc ?? false,
    createdAt: line.created_at,
    qcSummary: buildQcSummary(line.id, qcBreakdown, quantityReceived),
    putawayAcceptedQuantity: roundQuantity(acceptedQuantity),
    putawayPostedQuantity: postedQuantity,
    putawayStatus,
    remainingQuantityToPutaway: availability.remainingAfterPosted,
    availableForNewPutaway: availability.availableForPlanning,
    putawayBlockedReason: availability.blockedReason ?? null
  };
}

export function mapReceipt(
  row: any,
  lineRows: any[],
  qcBreakdown: Map<string, QcBreakdown>,
  totalsMap: Map<string, PutawayTotals>
) {
  return {
    id: row.id,
    receiptNumber: row.receipt_number ?? null,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNumber: row.po_number ?? null,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    vendorCode: row.vendor_code ?? null,
    status: row.status ?? 'posted',
    receivedAt: row.received_at,
    receivedToLocationId: row.received_to_location_id,
    receivedToLocationName: row.received_to_location_name ?? null,
    receivedToLocationCode: row.received_to_location_code ?? null,
    inventoryMovementId: row.inventory_movement_id,
    externalRef: row.external_ref,
    notes: row.notes,
    createdAt: row.created_at,
    hasPutaway: row.has_putaway ?? null,
    draftPutawayId: row.draft_putaway_id ?? null,
    lines: lineRows.map((line) => mapReceiptLine(line, qcBreakdown, totalsMap))
  };
}

export function buildReceiptStatusSummary(
  baseStatus: string | null | undefined,
  totals: ReceiptTotals
): ReceiptStatusSummary {
  const totalReceived = roundQuantity(totals.totalReceived);
  const totalAccept = roundQuantity(totals.totalAccept);
  const totalHold = roundQuantity(totals.totalHold);
  const totalReject = roundQuantity(totals.totalReject);
  const totalAcceptedQty = roundQuantity(totals.totalAcceptedQty);
  const putawayPosted = roundQuantity(totals.putawayPosted);
  const putawayPending = roundQuantity(totals.putawayPending);
  const receiptState = deriveReceiptLifecycleState({
    baseStatus,
    totalReceived,
    totalAccept,
    totalHold,
    totalReject
  });
  const hasReceived = totalReceived > STATUS_EPSILON;

  let qcStatus: ReceiptStatusSummary['qcStatus'];
  if (!hasReceived || receiptState === RECEIPT_STATES.QC_PENDING) {
    qcStatus = 'pending';
  } else if (receiptState === RECEIPT_STATES.AVAILABLE) {
    qcStatus = 'passed';
  } else {
    qcStatus = 'failed';
  }

  let putawayStatus: ReceiptStatusSummary['putawayStatus'] = 'not_available';
  if (qcStatus === 'passed' && totalAcceptedQty > STATUS_EPSILON) {
    const totalPutaway = putawayPosted + putawayPending;
    if (totalPutaway <= STATUS_EPSILON) {
      putawayStatus = 'not_started';
    } else if (putawayPosted + STATUS_EPSILON >= totalAcceptedQty) {
      putawayStatus = 'complete';
    } else {
      putawayStatus = 'pending';
    }
  }

  let workflowStatus = 'posted';
  if (baseStatus === 'voided') {
    workflowStatus = 'voided';
  } else if (baseStatus === 'draft') {
    workflowStatus = 'draft';
  } else if (!hasReceived) {
    workflowStatus = 'posted';
  } else if (receiptState === RECEIPT_STATES.QC_PENDING) {
    workflowStatus = 'pending_qc';
  } else if (receiptState === RECEIPT_STATES.REJECTED) {
    workflowStatus = 'qc_failed';
  } else if (putawayStatus === 'complete') {
    workflowStatus = 'complete';
  } else if (putawayStatus === 'pending') {
    workflowStatus = 'putaway_pending';
  } else {
    workflowStatus = 'qc_passed';
  }

  const qcEligible = baseStatus === 'posted' && receiptState === RECEIPT_STATES.QC_PENDING;
  const putawayEligible =
    baseStatus === 'posted' &&
    receiptState === RECEIPT_STATES.AVAILABLE &&
    totalAcceptedQty > STATUS_EPSILON &&
    putawayPosted + putawayPending + STATUS_EPSILON < totalAcceptedQty;

  return { workflowStatus, qcStatus, putawayStatus, qcEligible, putawayEligible };
}
