import type { PoolClient } from 'pg';
import { query } from '../../../../db';
import { roundQuantity, toNumber } from '../../../../lib/numbers';

type GetAvailableQuantityParams = {
  tenantId: string;
  warehouseId: string;
  itemId: string;
  locationId: string;
  uom: string;
  client?: PoolClient;
};

// inventory_ledger is the physical authority and reservations are the commitment
// authority. This query reads only the ledger-derived availability view and must
// never fall back to projection tables.
export async function getAvailableQuantity(params: GetAvailableQuantityParams): Promise<number> {
  const executor = params.client ? params.client.query.bind(params.client) : query;
  const availableRes = await executor<{ available_qty: string | number }>(
    `SELECT SUM(v.available_qty) AS available_qty
       FROM inventory_available_location_v v
      WHERE v.tenant_id = $1
        AND v.warehouse_id = $2
        AND v.item_id = $3
        AND v.location_id = $4
        AND v.uom = $5`,
    [params.tenantId, params.warehouseId, params.itemId, params.locationId, params.uom]
  );

  const availableQty = availableRes.rows[0]?.available_qty;
  if (availableQty == null) {
    // No canonical row means no on-hand and no active commitments for the scope.
    // Callers need a numeric zero here, not an exception path.
    return 0;
  }

  return roundQuantity(toNumber(availableQty));
}
