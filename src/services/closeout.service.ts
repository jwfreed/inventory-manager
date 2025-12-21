import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool, withTransaction } from '../db';
import { roundQuantity, toNumber } from '../lib/numbers';
import {
  calculateAcceptedQuantity,
  defaultBreakdown,
  loadPutawayTotals,
  loadQcBreakdown
} from './inbound/receivingAggregations';
import { receiptCloseSchema, poCloseSchema } from '../schemas/closeout.schema';
import { mapPurchaseOrder } from './purchaseOrders.service';

type ReceiptCloseInput = z.infer<typeof receiptCloseSchema>;
type PurchaseOrderCloseInput = z.infer<typeof poCloseSchema>;

type CloseoutRow = {
  id: string;
  purchase_order_receipt_id: string;
  status: 'open' | 'closed' | 'reopened';
  closed_at: string | null;
  closeout_reason_code: string | null;
  notes: string | null;
};

export type ReceiptLineReconciliation = {
  purchaseOrderReceiptLineId: string;
  quantityReceived: number;
  qcBreakdown: { hold: number; accept: number; reject: number };
  quantityPutawayPosted: number;
  remainingToPutaway: number;
  blockedReasons: string[];
};

export type ReceiptReconciliation = {
  receipt: {
    id: string;
    purchaseOrderId: string;
    status: 'open' | 'closed' | 'reopened';
    closedAt: string | null;
    closeout: {
      status: string;
      closedAt: string | null;
      closeoutReasonCode: string | null;
      notes: string | null;
    } | null;
  };
  lines: ReceiptLineReconciliation[];
};

export async function fetchReceiptReconciliation(
  tenantId: string,
  receiverId: string,
  client?: PoolClient
): Promise<ReceiptReconciliation | null> {
  const executor = client ?? pool;
  const receiptResult = await executor.query(
    'SELECT * FROM purchase_order_receipts WHERE id = $1 AND tenant_id = $2',
    [receiverId, tenantId]
  );
  if (receiptResult.rowCount === 0) {
    return null;
  }
  const receipt = receiptResult.rows[0];

  const linesResult = await executor.query(
    'SELECT * FROM purchase_order_receipt_lines WHERE purchase_order_receipt_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
    [receiverId, tenantId]
  );
  const lineIds = linesResult.rows.map((line: any) => line.id);
  const qcMap = await loadQcBreakdown(tenantId, lineIds, client);
  const totalsMap = await loadPutawayTotals(tenantId, lineIds, client);

  const closeoutResult = await executor.query<CloseoutRow>(
    'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1 AND tenant_id = $2',
    [receiverId, tenantId]
  );
  const closeout = closeoutResult.rows[0] ?? null;

  const lineSummaries: ReceiptLineReconciliation[] = linesResult.rows.map((line: any) => {
    const qc = qcMap.get(line.id) ?? defaultBreakdown();
    const totals = totalsMap.get(line.id) ?? { posted: 0, pending: 0 };
    const quantityReceived = roundQuantity(toNumber(line.quantity_received));
    const acceptedQty = calculateAcceptedQuantity(quantityReceived, qc);
    const postedQty = roundQuantity(totals.posted ?? 0);
    const remaining = Math.max(0, roundQuantity(acceptedQty - postedQty));
    const blockedReasons: string[] = [];
    if (roundQuantity(qc.hold ?? 0) > 0 && roundQuantity(qc.accept ?? 0) === 0) {
      blockedReasons.push('QC hold unresolved');
    }
    if (remaining > 0) {
      blockedReasons.push('Accepted quantity not fully put away');
    }
    return {
      purchaseOrderReceiptLineId: line.id,
      quantityReceived,
      qcBreakdown: {
        hold: roundQuantity(qc.hold ?? 0),
        accept: roundQuantity(qc.accept ?? 0),
        reject: roundQuantity(qc.reject ?? 0)
      },
      quantityPutawayPosted: postedQty,
      remainingToPutaway: remaining,
      blockedReasons
    };
  });

  return {
    receipt: {
      id: receipt.id,
      purchaseOrderId: receipt.purchase_order_id,
      status: closeout?.status ?? 'open',
      closedAt: closeout?.closed_at ?? null,
      closeout: closeout
        ? {
            status: closeout.status,
            closedAt: closeout.closed_at,
            closeoutReasonCode: closeout.closeout_reason_code,
            notes: closeout.notes
          }
        : null
    },
    lines: lineSummaries
  };
}

export async function closePurchaseOrderReceipt(
  tenantId: string,
  receiptId: string,
  data: ReceiptCloseInput
) {
  return withTransaction(async (client) => {
    const receiptRecon = await fetchReceiptReconciliation(tenantId, receiptId, client);
    if (!receiptRecon) {
      throw new Error('RECEIPT_NOT_FOUND');
    }

    const closeoutResult = await client.query<CloseoutRow>(
      'SELECT * FROM inbound_closeouts WHERE purchase_order_receipt_id = $1 AND tenant_id = $2 FOR UPDATE',
      [receiptId, tenantId]
    );
    const existingCloseout = closeoutResult.rows[0];
    if (existingCloseout && existingCloseout.status === 'closed') {
      throw new Error('RECEIPT_ALREADY_CLOSED');
    }

    const blockingLines = receiptRecon.lines.filter((line) => line.blockedReasons.length > 0);
    if (blockingLines.length > 0) {
      const reasons = Array.from(new Set(blockingLines.flatMap((line) => line.blockedReasons)));
      const error: any = new Error('RECEIPT_NOT_ELIGIBLE');
      error.reasons = reasons;
      throw error;
    }

    const now = new Date();
    if (existingCloseout) {
      await client.query(
        `UPDATE inbound_closeouts
            SET status = 'closed',
                closed_at = $1,
                closed_by_actor_type = $2,
                closed_by_actor_id = $3,
                closeout_reason_code = $4,
                notes = $5,
                updated_at = $1
          WHERE id = $6 AND tenant_id = $7`,
        [
          now,
          data.actorType ?? null,
          data.actorId ?? null,
          data.closeoutReasonCode ?? null,
          data.notes ?? null,
          existingCloseout.id,
          tenantId
        ]
      );
    } else {
      await client.query(
        `INSERT INTO inbound_closeouts (
            id, tenant_id, purchase_order_receipt_id, status, closed_at,
            closed_by_actor_type, closed_by_actor_id, closeout_reason_code, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7, $8, $4, $4)`,
        [
          uuidv4(),
          tenantId,
          receiptId,
          now,
          data.actorType ?? null,
          data.actorId ?? null,
          data.closeoutReasonCode ?? null,
          data.notes ?? null
        ]
      );
    }

    return fetchReceiptReconciliation(tenantId, receiptId, client);
  });
}

export async function closePurchaseOrder(tenantId: string, id: string, _data: PurchaseOrderCloseInput) {
  return withTransaction(async (client) => {
    const now = new Date();
    const poResult = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [
      id,
      tenantId
    ]);
    if (poResult.rowCount === 0) {
      throw new Error('PO_NOT_FOUND');
    }
    const po = poResult.rows[0];
    if (po.status === 'closed') {
      throw new Error('PO_ALREADY_CLOSED');
    }
    if (po.status === 'canceled') {
      throw new Error('PO_CANCELED');
    }

    const receiptsResult = await client.query(
      `SELECT por.id, ico.status
         FROM purchase_order_receipts por
         LEFT JOIN inbound_closeouts ico ON ico.purchase_order_receipt_id = por.id
        WHERE por.purchase_order_id = $1 AND por.tenant_id = $2`,
      [id, tenantId]
    );
    const blocking = receiptsResult.rows.filter((row: any) => row.status !== 'closed');
    if (receiptsResult.rowCount > 0 && blocking.length > 0) {
      throw new Error('PO_RECEIPTS_OPEN');
    }

    await client.query(
      'UPDATE purchase_orders SET status = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
      ['closed', now, id, tenantId]
    );

    const updatedPo = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId
    ]);
    const linesResult = await client.query(
      'SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 AND tenant_id = $2 ORDER BY line_number ASC',
      [id, tenantId]
    );
    return mapPurchaseOrder(updatedPo.rows[0], linesResult.rows);
  });
}
