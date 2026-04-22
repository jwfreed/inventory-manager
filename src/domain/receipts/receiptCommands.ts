import type { PoolClient } from 'pg';
import {
  RECEIPT_EVENTS,
  RECEIPT_STATES,
  applyReceiptStateTransition,
  type ReceiptState
} from './receiptStateModel';

export async function validateReceiptCommand(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
}) {
  return applyReceiptStateTransition({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    currentState: RECEIPT_STATES.RECEIVED,
    event: RECEIPT_EVENTS.VALIDATE,
    occurredAt: params.occurredAt
  });
}

export async function postInventoryCommand(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
  currentState?: ReceiptState;
}) {
  return applyReceiptStateTransition({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    currentState: params.currentState ?? RECEIPT_STATES.VALIDATED,
    event: RECEIPT_EVENTS.START_QC,
    occurredAt: params.occurredAt
  });
}

export async function evaluateQcCommand(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
  currentState: ReceiptState;
  qcComplete: boolean;
  acceptedQty: number;
  heldQty: number;
  rejectedQty: number;
  receivedQty: number;
  // Rework is not permanent rejection; if any units were reworked the receipt
  // is not "fully rejected" even when acceptedQty == 0.
  reworkedQty?: number;
}) {
  if (params.currentState !== RECEIPT_STATES.QC_PENDING) {
    return params.currentState;
  }
  if (!params.qcComplete) {
    return params.currentState;
  }
  if (params.heldQty > 1e-6) {
    return params.currentState;
  }

  const completedState = await applyReceiptStateTransition({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    currentState: params.currentState,
    event: RECEIPT_EVENTS.COMPLETE_QC,
    occurredAt: params.occurredAt,
    metadata: {
      totalReceived: params.receivedQty,
      totalAccept: params.acceptedQty,
      totalHold: params.heldQty,
      totalReject: params.rejectedQty
    }
  });

  if (params.acceptedQty > 0 || (params.reworkedQty ?? 0) > 1e-6) {
    return completedState;
  }

  return applyReceiptStateTransition({
    client: params.client,
    tenantId: params.tenantId,
    receiptId: params.receiptId,
    currentState: completedState,
    event: RECEIPT_EVENTS.REJECT,
    occurredAt: params.occurredAt,
    metadata: {
      reason: 'qc_no_accepted_quantity',
      totalReceived: params.receivedQty,
      totalHold: params.heldQty,
      totalReject: params.rejectedQty
    }
  });
}

export async function completePutawayCommand(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  occurredAt: Date;
  currentState: ReceiptState;
  putawayStarted: boolean;
  putawayComplete: boolean;
  acceptedQty: number;
  availableQty: number;
}) {
  if (params.currentState === RECEIPT_STATES.REJECTED || params.currentState === RECEIPT_STATES.AVAILABLE) {
    return params.currentState;
  }

  let currentState: ReceiptState = params.currentState;
  if (currentState === RECEIPT_STATES.QC_COMPLETED) {
    if (!params.putawayStarted) {
      return currentState;
    }
    currentState = await applyReceiptStateTransition({
      client: params.client,
      tenantId: params.tenantId,
      receiptId: params.receiptId,
      currentState,
      event: RECEIPT_EVENTS.START_PUTAWAY,
      occurredAt: params.occurredAt,
      metadata: {
        totalAvailable: params.availableQty,
        totalAccept: params.acceptedQty
      }
    });
  }

  if (currentState === RECEIPT_STATES.PUTAWAY_PENDING && params.putawayComplete) {
    currentState = await applyReceiptStateTransition({
      client: params.client,
      tenantId: params.tenantId,
      receiptId: params.receiptId,
      currentState,
      event: RECEIPT_EVENTS.COMPLETE_PUTAWAY,
      occurredAt: params.occurredAt,
      metadata: {
        totalAvailable: params.availableQty,
        totalAccept: params.acceptedQty
      }
    });
  }

  return currentState;
}
