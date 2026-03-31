import type { PoolClient } from 'pg';
import { roundQuantity, toNumber } from '../../lib/numbers';
import { RECEIPT_STATUS_EPSILON } from '../../domain/receipts/receiptPolicy';
import {
  RECEIPT_EVENTS,
  RECEIPT_STATES,
  applyReceiptStateTransition,
  type ReceiptState
} from '../../domain/receipts/receiptStateModel';

type ReceiptLifecycleFacts = {
  state: ReceiptState;
  totalReceived: number;
  totalAccept: number;
  totalHold: number;
  totalReject: number;
  totalAvailable: number;
};

async function loadReceiptLifecycleFacts(
  client: PoolClient,
  tenantId: string,
  receiptId: string
): Promise<ReceiptLifecycleFacts> {
  const { rows } = await client.query(
    `WITH line_qc AS (
        SELECT prl.purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0)::numeric AS accept_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0)::numeric AS hold_qty,
               COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0)::numeric AS reject_qty
          FROM purchase_order_receipt_lines prl
          LEFT JOIN qc_events qe
            ON qe.purchase_order_receipt_line_id = prl.id
           AND qe.tenant_id = prl.tenant_id
         WHERE prl.purchase_order_receipt_id = $1
           AND prl.tenant_id = $2
         GROUP BY prl.purchase_order_receipt_id
      ),
      line_alloc AS (
        SELECT purchase_order_receipt_id AS receipt_id,
               COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN quantity ELSE 0 END), 0)::numeric AS available_qty
          FROM receipt_allocations
         WHERE purchase_order_receipt_id = $1
           AND tenant_id = $2
         GROUP BY purchase_order_receipt_id
      )
      SELECT por.lifecycle_state,
             COALESCE(SUM(prl.quantity_received), 0)::numeric AS total_received,
             COALESCE(lq.accept_qty, 0)::numeric AS total_accept,
             COALESCE(lq.hold_qty, 0)::numeric AS total_hold,
             COALESCE(lq.reject_qty, 0)::numeric AS total_reject,
             COALESCE(la.available_qty, 0)::numeric AS total_available
        FROM purchase_order_receipts por
        LEFT JOIN purchase_order_receipt_lines prl
          ON prl.purchase_order_receipt_id = por.id
         AND prl.tenant_id = por.tenant_id
        LEFT JOIN line_qc lq
          ON lq.receipt_id = por.id
        LEFT JOIN line_alloc la
          ON la.receipt_id = por.id
       WHERE por.id = $1
         AND por.tenant_id = $2
       GROUP BY por.lifecycle_state, lq.accept_qty, lq.hold_qty, lq.reject_qty, la.available_qty`,
    [receiptId, tenantId]
  );
  if ((rows.length ?? 0) === 0) {
    throw new Error('RECEIPT_NOT_FOUND');
  }
  const row = rows[0];
  return {
    state: row.lifecycle_state,
    totalReceived: roundQuantity(toNumber(row.total_received ?? 0)),
    totalAccept: roundQuantity(toNumber(row.total_accept ?? 0)),
    totalHold: roundQuantity(toNumber(row.total_hold ?? 0)),
    totalReject: roundQuantity(toNumber(row.total_reject ?? 0)),
    totalAvailable: roundQuantity(toNumber(row.total_available ?? 0))
  };
}

export async function synchronizeReceiptLifecycleState(
  client: PoolClient,
  tenantId: string,
  receiptId: string,
  occurredAt: Date
) {
  let facts = await loadReceiptLifecycleFacts(client, tenantId, receiptId);
  let currentState = facts.state;
  const transitions: string[] = [];

  const qcComplete =
    facts.totalReceived > RECEIPT_STATUS_EPSILON &&
    facts.totalReceived - (facts.totalAccept + facts.totalHold + facts.totalReject) <= RECEIPT_STATUS_EPSILON;

  if (currentState === RECEIPT_STATES.QC_PENDING && qcComplete) {
    currentState = await applyReceiptStateTransition({
      client,
      tenantId,
      receiptId,
      currentState,
      event: RECEIPT_EVENTS.COMPLETE_QC,
      occurredAt,
      metadata: {
        totalReceived: facts.totalReceived,
        totalAccept: facts.totalAccept,
        totalHold: facts.totalHold,
        totalReject: facts.totalReject
      }
    });
    transitions.push(currentState);
    facts = await loadReceiptLifecycleFacts(client, tenantId, receiptId);
  }

  if (
    currentState === RECEIPT_STATES.QC_COMPLETED &&
    facts.totalAccept <= RECEIPT_STATUS_EPSILON
  ) {
    currentState = await applyReceiptStateTransition({
      client,
      tenantId,
      receiptId,
      currentState,
      event: RECEIPT_EVENTS.REJECT,
      occurredAt,
      metadata: {
        totalAccept: facts.totalAccept,
        totalHold: facts.totalHold,
        totalReject: facts.totalReject
      }
    });
    transitions.push(currentState);
    return { state: currentState, transitions };
  }

  if (
    currentState === RECEIPT_STATES.QC_COMPLETED &&
    facts.totalAvailable > RECEIPT_STATUS_EPSILON
  ) {
    currentState = await applyReceiptStateTransition({
      client,
      tenantId,
      receiptId,
      currentState,
      event: RECEIPT_EVENTS.START_PUTAWAY,
      occurredAt,
      metadata: {
        totalAvailable: facts.totalAvailable,
        totalAccept: facts.totalAccept
      }
    });
    transitions.push(currentState);
    facts = await loadReceiptLifecycleFacts(client, tenantId, receiptId);
  }

  if (
    currentState === RECEIPT_STATES.PUTAWAY_PENDING &&
    facts.totalAvailable + RECEIPT_STATUS_EPSILON >= facts.totalAccept &&
    facts.totalAccept > RECEIPT_STATUS_EPSILON
  ) {
    currentState = await applyReceiptStateTransition({
      client,
      tenantId,
      receiptId,
      currentState,
      event: RECEIPT_EVENTS.COMPLETE_PUTAWAY,
      occurredAt,
      metadata: {
        totalAvailable: facts.totalAvailable,
        totalAccept: facts.totalAccept
      }
    });
    transitions.push(currentState);
  }

  return { state: currentState, transitions };
}
