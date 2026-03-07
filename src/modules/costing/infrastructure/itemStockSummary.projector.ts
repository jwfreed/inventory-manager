import type { PoolClient } from 'pg';
import { query } from '../../../db';
import { roundQuantity, toNumber } from '../../../lib/numbers';

export interface ItemStockSummaryProjection {
  quantityOnHand: number;
}

function normalizeQuantity(value: unknown): number {
  return roundQuantity(toNumber(value));
}

// items.quantity_on_hand is a derived summary. Physical inventory authority
// remains in inventory_movements/inventory_movement_lines and must be rebuilt
// from the ledger rather than incremented as if it were authoritative.
export async function getItemQuantityOnHandProjectionFromLedger(
  tenantId: string,
  itemId: string,
  client?: PoolClient
): Promise<number> {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor<{ quantity_on_hand: string | number }>(
    `SELECT COALESCE(SUM(COALESCE(l.quantity_delta_canonical, l.quantity_delta)), 0) AS quantity_on_hand
       FROM inventory_movement_lines l
       JOIN inventory_movements m
         ON m.id = l.movement_id
        AND m.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.item_id = $2
        AND m.status = 'posted'`,
    [tenantId, itemId]
  );
  return normalizeQuantity(result.rows[0]?.quantity_on_hand ?? 0);
}

export async function refreshItemQuantityOnHandProjection(
  tenantId: string,
  itemId: string,
  client: PoolClient
): Promise<number> {
  const quantityOnHand = await getItemQuantityOnHandProjectionFromLedger(tenantId, itemId, client);
  await client.query(
    `UPDATE items
        SET quantity_on_hand = $1,
            updated_at = now()
      WHERE id = $2
        AND tenant_id = $3`,
    [quantityOnHand, itemId, tenantId]
  );
  return quantityOnHand;
}

// Legacy compatibility wrapper. Quantity summaries are rebuilt from the ledger
// even when older service paths still call this function with deltas.
export async function applyItemQuantityOnHandProjectionDelta(
  tenantId: string,
  itemId: string,
  _quantityDelta: number,
  client: PoolClient
): Promise<void> {
  await refreshItemQuantityOnHandProjection(tenantId, itemId, client);
}
