import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query } from '../db';

export type BackorderInput = {
  demandType: 'sales_order_line';
  demandId: string;
  itemId: string;
  locationId: string;
  uom: string;
  quantity: number;
  notes?: string | null;
};

let backordersTableAvailable: boolean | null = null;

async function hasBackordersTable(): Promise<boolean> {
  if (backordersTableAvailable !== null) return backordersTableAvailable;
  const { rows } = await query<{ exists: string | null }>(
    `SELECT to_regclass('inventory_backorders') AS exists`
  );
  backordersTableAvailable = Boolean(rows[0]?.exists);
  return backordersTableAvailable;
}

export async function upsertBackorder(
  tenantId: string,
  data: BackorderInput,
  client?: PoolClient
) {
  if (!(await hasBackordersTable())) {
    return null;
  }
  const executor = client ? client.query.bind(client) : query;
  const now = new Date();
  const res = await executor(
    `INSERT INTO inventory_backorders (
        id, tenant_id, status, demand_type, demand_id, item_id, location_id, uom,
        quantity_backordered, backordered_at, notes, created_at, updated_at
     ) VALUES ($11, $1, 'open', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (tenant_id, demand_type, demand_id, item_id, location_id, uom)
     DO UPDATE SET
       quantity_backordered = inventory_backorders.quantity_backordered + EXCLUDED.quantity_backordered,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      tenantId,
      data.demandType,
      data.demandId,
      data.itemId,
      data.locationId,
      data.uom,
      data.quantity,
      now,
      data.notes ?? null,
      now,
      uuidv4()
    ]
  );
  return res.rows[0];
}
