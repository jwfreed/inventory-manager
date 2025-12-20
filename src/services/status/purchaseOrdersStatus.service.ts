import { query } from '../../db';
import { roundQuantity, toNumber } from '../../lib/numbers';

export async function updatePoStatusFromReceipts(poId: string) {
  // Compute ordered vs received
  const { rows: orderedRows } = await query(
    `SELECT pol.id, pol.quantity_ordered, pol.uom
       FROM purchase_order_lines pol
      WHERE pol.purchase_order_id = $1`,
    [poId]
  );
  if (orderedRows.length === 0) return;

  const { rows: receivedRows } = await query(
    `SELECT porl.purchase_order_line_id AS line_id, SUM(porl.quantity_received) AS qty
       FROM purchase_order_receipt_lines porl
       JOIN purchase_order_receipts por ON por.id = porl.purchase_order_receipt_id
      WHERE por.purchase_order_id = $1
      GROUP BY porl.purchase_order_line_id`,
    [poId]
  );
  const receivedMap = new Map<string, number>();
  receivedRows.forEach((row) => {
    receivedMap.set(row.line_id, roundQuantity(toNumber(row.qty)));
  });

  let anyReceived = false;
  let allFullyReceived = true;
  for (const line of orderedRows) {
    const ordered = roundQuantity(toNumber(line.quantity_ordered));
    const received = receivedMap.get(line.id) ?? 0;
    if (received > 0) anyReceived = true;
    if (received < ordered) {
      allFullyReceived = false;
    }
  }

  let nextStatus: string | null = null;
  if (allFullyReceived) {
    nextStatus = 'received';
  } else if (anyReceived) {
    nextStatus = 'partially_received';
  }
  if (!nextStatus) return;

  await query(
    `UPDATE purchase_orders
        SET status = $2,
            updated_at = now()
      WHERE id = $1`,
    [poId, nextStatus]
  );
}
