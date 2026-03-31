import { roundQuantity } from '../../lib/numbers';
import { RECEIPT_STATUS_EPSILON } from './receiptPolicy';
import { RECEIPT_STATES, type ReceiptLifecycleState } from './receiptStateModel';

export const RECEIPT_AVAILABILITY_STATES = {
  UNAVAILABLE: 'UNAVAILABLE',
  AVAILABLE: 'AVAILABLE'
} as const;

export type ReceiptAvailabilityState =
  typeof RECEIPT_AVAILABILITY_STATES[keyof typeof RECEIPT_AVAILABILITY_STATES];

export type ReceiptAvailabilityDecision = {
  state: ReceiptAvailabilityState;
  availableQty: number;
  blockedQty: number;
  blockedReasons: string[];
};

export function buildReceiptQcOutcome(params: {
  quantityReceived: number;
  acceptedQty: number;
  heldQty: number;
  rejectedQty: number;
}) {
  const quantityReceived = roundQuantity(params.quantityReceived);
  const acceptedQty = roundQuantity(params.acceptedQty);
  const heldQty = roundQuantity(params.heldQty);
  const rejectedQty = roundQuantity(params.rejectedQty);
  const inspectedQty = roundQuantity(acceptedQty + heldQty + rejectedQty);
  const remainingQty = roundQuantity(Math.max(0, quantityReceived - inspectedQty));
  return {
    quantityReceived,
    acceptedQty,
    heldQty,
    rejectedQty,
    inspectedQty,
    remainingQty
  };
}

export function assertReceiptQcOutcomeIntegrity(params: {
  quantityReceived: number;
  acceptedQty: number;
  heldQty: number;
  rejectedQty: number;
}) {
  const outcome = buildReceiptQcOutcome(params);
  if (Math.abs(outcome.inspectedQty + outcome.remainingQty - outcome.quantityReceived) > RECEIPT_STATUS_EPSILON) {
    throw new Error('RECEIPT_QC_QUANTITY_INTEGRITY_VIOLATION');
  }
  return outcome;
}

export function deriveReceiptAvailability(params: {
  baseStatus: string | null | undefined;
  lifecycleState: ReceiptLifecycleState;
  acceptedQty: number;
  heldQty: number;
  postedToAvailableQty: number;
  blockedQty?: number;
}): ReceiptAvailabilityDecision {
  const acceptedQty = roundQuantity(params.acceptedQty);
  const heldQty = roundQuantity(params.heldQty);
  const postedToAvailableQty = roundQuantity(params.postedToAvailableQty);
  const blockedQty = roundQuantity(params.blockedQty ?? 0);
  const blockedReasons: string[] = [];

  if (params.baseStatus === 'voided') {
    blockedReasons.push('Receipt is voided.');
  }
  if (params.lifecycleState !== RECEIPT_STATES.AVAILABLE) {
    blockedReasons.push('Receipt lifecycle is not available.');
  }
  if (heldQty > RECEIPT_STATUS_EPSILON) {
    blockedReasons.push('Held quantity must not contribute to availability.');
  }
  if (blockedQty > RECEIPT_STATUS_EPSILON) {
    blockedReasons.push('Blocked quantity must not contribute to availability.');
  }

  const availableQty = Math.max(0, roundQuantity(Math.min(acceptedQty, postedToAvailableQty) - blockedQty));
  const unavailableAcceptedQty = Math.max(0, roundQuantity(acceptedQty - availableQty));
  const unavailableQty = roundQuantity(unavailableAcceptedQty + heldQty + blockedQty);

  if (params.lifecycleState !== RECEIPT_STATES.AVAILABLE || availableQty <= RECEIPT_STATUS_EPSILON) {
    return {
      state: RECEIPT_AVAILABILITY_STATES.UNAVAILABLE,
      availableQty: 0,
      blockedQty: roundQuantity(unavailableQty + availableQty),
      blockedReasons
    };
  }

  return {
    state: RECEIPT_AVAILABILITY_STATES.AVAILABLE,
    availableQty,
    blockedQty: unavailableQty,
    blockedReasons
  };
}

export function calculateReceiptPutawayStatus(params: {
  acceptedQty: number;
  putawayCompletedQty: number;
  putawayPendingQty: number;
}) {
  const acceptedQty = roundQuantity(params.acceptedQty);
  const putawayCompletedQty = roundQuantity(params.putawayCompletedQty);
  const putawayPendingQty = roundQuantity(params.putawayPendingQty);
  const totalPlannedOrCompleted = roundQuantity(putawayCompletedQty + putawayPendingQty);

  if (acceptedQty <= RECEIPT_STATUS_EPSILON) {
    return 'not_available' as const;
  }
  if (totalPlannedOrCompleted <= RECEIPT_STATUS_EPSILON) {
    return 'not_started' as const;
  }
  if (putawayCompletedQty + RECEIPT_STATUS_EPSILON >= acceptedQty) {
    return 'complete' as const;
  }
  return 'pending' as const;
}
