import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';

export const RECEIPT_STATES = {
  RECEIVED: 'RECEIVED',
  VALIDATED: 'VALIDATED',
  QC_PENDING: 'QC_PENDING',
  QC_COMPLETED: 'QC_COMPLETED',
  PUTAWAY_PENDING: 'PUTAWAY_PENDING',
  AVAILABLE: 'AVAILABLE',
  REJECTED: 'REJECTED'
} as const;

export type ReceiptState = typeof RECEIPT_STATES[keyof typeof RECEIPT_STATES];
export type ReceiptLifecycleState = ReceiptState;

export const RECEIPT_EVENTS = {
  VALIDATE: 'VALIDATE',
  START_QC: 'START_QC',
  COMPLETE_QC: 'COMPLETE_QC',
  START_PUTAWAY: 'START_PUTAWAY',
  COMPLETE_PUTAWAY: 'COMPLETE_PUTAWAY',
  REJECT: 'REJECT'
} as const;

export type ReceiptEvent = typeof RECEIPT_EVENTS[keyof typeof RECEIPT_EVENTS];

export const RECEIPT_ALLOWED_TRANSITIONS: Record<ReceiptState, Partial<Record<ReceiptEvent, ReceiptState>>> = {
  [RECEIPT_STATES.RECEIVED]: {
    [RECEIPT_EVENTS.VALIDATE]: RECEIPT_STATES.VALIDATED
  },
  [RECEIPT_STATES.VALIDATED]: {
    [RECEIPT_EVENTS.START_QC]: RECEIPT_STATES.QC_PENDING
  },
  [RECEIPT_STATES.QC_PENDING]: {
    [RECEIPT_EVENTS.COMPLETE_QC]: RECEIPT_STATES.QC_COMPLETED
  },
  [RECEIPT_STATES.QC_COMPLETED]: {
    [RECEIPT_EVENTS.START_PUTAWAY]: RECEIPT_STATES.PUTAWAY_PENDING,
    [RECEIPT_EVENTS.REJECT]: RECEIPT_STATES.REJECTED
  },
  [RECEIPT_STATES.PUTAWAY_PENDING]: {
    [RECEIPT_EVENTS.COMPLETE_PUTAWAY]: RECEIPT_STATES.AVAILABLE,
    [RECEIPT_EVENTS.REJECT]: RECEIPT_STATES.REJECTED
  },
  [RECEIPT_STATES.AVAILABLE]: {},
  [RECEIPT_STATES.REJECTED]: {}
};

export function getReceiptNextState(current: ReceiptState, event: ReceiptEvent): ReceiptState {
  const next = RECEIPT_ALLOWED_TRANSITIONS[current][event];
  if (!next) {
    throw new Error('RECEIPT_INVALID_STATE_TRANSITION');
  }
  return next;
}

export function transitionReceiptState(current: ReceiptState, event: ReceiptEvent): ReceiptState {
  return getReceiptNextState(current, event);
}

export function buildReceiptCreationState(): ReceiptState {
  return transitionReceiptState(
    transitionReceiptState(RECEIPT_STATES.RECEIVED, RECEIPT_EVENTS.VALIDATE),
    RECEIPT_EVENTS.START_QC
  );
}

export function assertReceiptInventoryUnavailable(state: ReceiptState) {
  if (state === RECEIPT_STATES.AVAILABLE) {
    throw new Error('RECEIPT_AVAILABLE_STATE_REQUIRES_QC');
  }
}

export async function applyReceiptStateTransition(params: {
  client: PoolClient;
  tenantId: string;
  receiptId: string;
  currentState: ReceiptState;
  event: ReceiptEvent;
  occurredAt: Date;
  metadata?: Record<string, unknown> | null;
}) {
  const nextState = transitionReceiptState(params.currentState, params.event);
  const updateResult = await params.client.query(
    `UPDATE purchase_order_receipts
        SET lifecycle_state = $3
      WHERE id = $1
        AND tenant_id = $2
        AND lifecycle_state = $4`,
    [params.receiptId, params.tenantId, nextState, params.currentState]
  );
  if ((updateResult.rowCount ?? 0) !== 1) {
    throw new Error('RECEIPT_STATE_PERSISTENCE_CONFLICT');
  }
  await params.client.query(
    `INSERT INTO receipt_state_transitions (
        id, tenant_id, purchase_order_receipt_id, event, from_state, to_state, metadata, occurred_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    [
      uuidv4(),
      params.tenantId,
      params.receiptId,
      params.event,
      params.currentState,
      nextState,
      params.metadata ?? null,
      params.occurredAt
    ]
  );
  return nextState;
}
