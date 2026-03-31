import { roundQuantity } from '../../lib/numbers';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';

export const RECEIPT_STATES = {
  RECEIVED: 'RECEIVED',
  VALIDATED: 'VALIDATED',
  QC_PENDING: 'QC_PENDING',
  AVAILABLE: 'AVAILABLE',
  REJECTED: 'REJECTED'
} as const;

export type ReceiptLifecycleState =
  typeof RECEIPT_STATES[keyof typeof RECEIPT_STATES];

const ALLOWED_TRANSITIONS: Record<ReceiptLifecycleState, ReceiptLifecycleState[]> = {
  [RECEIPT_STATES.RECEIVED]: [RECEIPT_STATES.VALIDATED],
  [RECEIPT_STATES.VALIDATED]: [RECEIPT_STATES.QC_PENDING],
  [RECEIPT_STATES.QC_PENDING]: [RECEIPT_STATES.AVAILABLE, RECEIPT_STATES.REJECTED],
  [RECEIPT_STATES.AVAILABLE]: [],
  [RECEIPT_STATES.REJECTED]: []
};

export function transitionReceiptState(
  current: ReceiptLifecycleState,
  next: ReceiptLifecycleState
): ReceiptLifecycleState {
  if (current === next) {
    return current;
  }
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error('RECEIPT_INVALID_STATE_TRANSITION');
  }
  return next;
}

export function assertReceiptInventoryUnavailable(
  state: ReceiptLifecycleState
) {
  if (state === RECEIPT_STATES.AVAILABLE) {
    throw new Error('RECEIPT_AVAILABLE_STATE_REQUIRES_QC');
  }
}

export function buildReceiptCreationState(): ReceiptLifecycleState {
  return transitionReceiptState(
    transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_STATES.VALIDATED),
    RECEIPT_STATES.QC_PENDING
  );
}

export function deriveReceiptLifecycleState(params: {
  baseStatus: string | null | undefined;
  totalReceived: number;
  totalAccept: number;
  totalHold: number;
  totalReject: number;
}): ReceiptLifecycleState {
  if (params.baseStatus === 'voided') {
    return RECEIPT_STATES.REJECTED;
  }

  const totalReceived = roundQuantity(params.totalReceived);
  const totalAccept = roundQuantity(params.totalAccept);
  const totalHold = roundQuantity(params.totalHold);
  const totalReject = roundQuantity(params.totalReject);

  if (totalReceived <= RECEIPT_STATUS_EPSILON) {
    return RECEIPT_STATES.RECEIVED;
  }

  const remainingQc = Math.max(0, totalReceived - (totalAccept + totalHold + totalReject));
  if (remainingQc > RECEIPT_STATUS_EPSILON) {
    return RECEIPT_STATES.QC_PENDING;
  }
  if (totalHold > RECEIPT_STATUS_EPSILON) {
    return RECEIPT_STATES.REJECTED;
  }
  if (totalAccept > RECEIPT_STATUS_EPSILON) {
    return RECEIPT_STATES.AVAILABLE;
  }
  return RECEIPT_STATES.REJECTED;
}

export function deriveReceiptState(params: {
  baseStatus: string | null | undefined;
  totals: {
    totalReceived: number;
    totalAccept: number;
    totalHold: number;
    totalReject: number;
  };
}): ReceiptLifecycleState {
  return deriveReceiptLifecycleState({
    baseStatus: params.baseStatus,
    totalReceived: params.totals.totalReceived,
    totalAccept: params.totals.totalAccept,
    totalHold: params.totals.totalHold,
    totalReject: params.totals.totalReject
  });
}
