import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query } from '../../db';
import { roundQuantity, toNumber } from '../../lib/numbers';

const STATUS_EPSILON = 1e-6;
const CLOSED_LINE_STATUSES = new Set(['closed_short', 'cancelled']);
const OPEN_OR_COMPLETE_STATUSES = new Set(['open', 'complete']);

type LineAggregateRow = {
  id: string;
  quantity_ordered: string | number;
  status: string | null;
  qty_received: string | number | null;
};

type OrderStatusRow = {
  status: string;
  closed_at: string | null;
};

type QueryExecutor = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
) => Promise<QueryResult<T>>;

function getExecutor(client?: PoolClient): QueryExecutor {
  if (client) {
    return <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      client.query<T>(text, values);
  }
  return <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => query<T>(text, values);
}

async function loadLineAggregates(
  executor: QueryExecutor,
  tenantId: string,
  poId: string
): Promise<Array<{ id: string; ordered: number; received: number; status: string }>> {
  // Intentionally read-only aggregate: this function does not lock all PO lines.
  // Receipt/close mutation paths acquire row-level line locks before writing.
  // Here we only need a consistent derived snapshot for status recomputation.
  const { rows } = await executor<LineAggregateRow>(
    `SELECT pol.id,
            pol.quantity_ordered,
            pol.status,
            COALESCE(SUM(porl.quantity_received), 0) AS qty_received
       FROM purchase_order_lines pol
       LEFT JOIN purchase_order_receipt_lines porl
         ON porl.purchase_order_line_id = pol.id
        AND porl.tenant_id = pol.tenant_id
       LEFT JOIN purchase_order_receipts por
         ON por.id = porl.purchase_order_receipt_id
        AND por.tenant_id = porl.tenant_id
        AND COALESCE(por.status, 'posted') <> 'voided'
      WHERE pol.purchase_order_id = $1
        AND pol.tenant_id = $2
      GROUP BY pol.id, pol.quantity_ordered, pol.status
      ORDER BY pol.line_number ASC`,
    [poId, tenantId]
  );

  return rows.map((row) => ({
    id: row.id,
    ordered: roundQuantity(toNumber(row.quantity_ordered)),
    received: roundQuantity(toNumber(row.qty_received ?? 0)),
    status: String(row.status ?? 'open')
  }));
}

export async function updatePoStatusFromReceipts(tenantId: string, poId: string, client?: PoolClient) {
  const executor = getExecutor(client);
  // Lock scope note:
  // - When a transaction client is provided, we lock only the purchase_orders row (FOR UPDATE).
  // - We intentionally do not lock every purchase_order_lines row in this derivation path.
  // - This is safe because line-level writers (receipts, line-close, PO-close flows) lock the rows they mutate.
  // - PO status is a derived projection and can be recomputed; the ledger remains authoritative.
  // - Terminal PO states remain fail-safe (closed/canceled do not auto-reopen here).
  const poResult = await executor<OrderStatusRow>(
    `SELECT status, closed_at
       FROM purchase_orders
      WHERE id = $1
        AND tenant_id = $2
      ${client ? 'FOR UPDATE' : ''}`,
    [poId, tenantId]
  );
  if (poResult.rowCount === 0) return;

  const po = poResult.rows[0];
  if (po.status === 'closed') {
    return;
  }
  const lineRows = await loadLineAggregates(executor, tenantId, poId);
  if (lineRows.length === 0) return;

  const resolvedLineStates: Array<{ id: string; status: string; ordered: number; received: number }> = [];
  for (const line of lineRows) {
    let resolvedStatus = line.status || 'open';
    if (OPEN_OR_COMPLETE_STATUSES.has(resolvedStatus)) {
      const derived = line.received + STATUS_EPSILON >= line.ordered ? 'complete' : 'open';
      if (derived !== resolvedStatus) {
        await executor(
          `UPDATE purchase_order_lines
              SET status = $1,
                  closed_reason = NULL,
                  closed_notes = NULL,
                  closed_at = NULL,
                  closed_by_user_id = NULL
            WHERE id = $2
              AND tenant_id = $3`,
          [derived, line.id, tenantId]
        );
      }
      resolvedStatus = derived;
    }
    resolvedLineStates.push({
      id: line.id,
      status: resolvedStatus,
      ordered: line.ordered,
      received: line.received
    });
  }

  if (po.status === 'canceled') {
    return;
  }

  const openCount = resolvedLineStates.filter((line) => line.status === 'open').length;
  const closedCount = resolvedLineStates.filter((line) => CLOSED_LINE_STATUSES.has(line.status)).length;
  const hasReceived = resolvedLineStates.some((line) => line.received > STATUS_EPSILON);

  let nextStatus = po.status;
  if (openCount === 0) {
    nextStatus = closedCount > 0 ? 'closed' : 'received';
  } else if (hasReceived) {
    nextStatus = 'partially_received';
  } else if (['partially_received', 'received'].includes(po.status)) {
    nextStatus = 'approved';
  }

  if (nextStatus === po.status) {
    return;
  }

  if (nextStatus === 'closed') {
    await executor(
      `UPDATE purchase_orders
          SET status = $2,
              closed_at = COALESCE(closed_at, now()),
              close_reason = COALESCE(close_reason, 'line_closure'),
              updated_at = now()
        WHERE id = $1
          AND tenant_id = $3`,
      [poId, nextStatus, tenantId]
    );
    return;
  }

  await executor(
    `UPDATE purchase_orders
        SET status = $2,
            updated_at = now()
      WHERE id = $1
        AND tenant_id = $3`,
    [poId, nextStatus, tenantId]
  );
}
