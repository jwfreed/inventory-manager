import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { z } from 'zod';

export const ncrUpdateSchema = z.object({
  dispositionType: z.enum(['return_to_vendor', 'scrap', 'rework', 'use_as_is']),
  dispositionNotes: z.string().max(2000).optional()
});

export type NcrUpdateInput = z.infer<typeof ncrUpdateSchema>;

async function generateNcrNumber(tenantId: string, client: PoolClient) {
  await client.query(
    `INSERT INTO ncr_sequences (tenant_id, next_number)
     VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId]
  );

  const seqResult = await client.query<{ next_number: number }>(
    'SELECT next_number FROM ncr_sequences WHERE tenant_id = $1 FOR UPDATE',
    [tenantId]
  );
  const nextNumber = Number(seqResult.rows[0].next_number);
  const formatted = `NCR-${String(nextNumber).padStart(6, '0')}`;

  await client.query(
    'UPDATE ncr_sequences SET next_number = $2 WHERE tenant_id = $1',
    [tenantId, nextNumber + 1]
  );

  return formatted;
}

export async function createNcr(
  tenantId: string,
  qcEventId: string,
  client: PoolClient
) {
  const ncrNumber = await generateNcrNumber(tenantId, client);
  const id = uuidv4();
  
  const { rows } = await client.query(
    `INSERT INTO ncrs (
        id, tenant_id, qc_event_id, ncr_number, status
     ) VALUES ($1, $2, $3, $4, 'open')
     RETURNING *`,
    [id, tenantId, qcEventId, ncrNumber]
  );
  
  return rows[0];
}

export async function findMrbLocation(tenantId: string, client: PoolClient) {
  const { rows } = await client.query(
    "SELECT id FROM locations WHERE type = 'mrb' AND active = true AND tenant_id = $1 LIMIT 1",
    [tenantId]
  );
  return rows[0]?.id || null;
}

export async function getNcr(tenantId: string, id: string) {
  const { rows } = await query(
    `SELECT n.*, 
            q.event_type, q.quantity, q.uom, q.reason_code,
            q.purchase_order_receipt_line_id, q.work_order_id, q.work_order_execution_line_id
       FROM ncrs n
       JOIN qc_events q ON q.id = n.qc_event_id
      WHERE n.id = $1 AND n.tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] || null;
}

export async function listNcrs(tenantId: string, status?: 'open' | 'closed') {
  let sql = `
    SELECT n.*, 
           q.event_type, q.quantity, q.uom, q.reason_code
      FROM ncrs n
      JOIN qc_events q ON q.id = n.qc_event_id
     WHERE n.tenant_id = $1
  `;
  const params: any[] = [tenantId];
  
  if (status) {
    sql += ` AND n.status = $2`;
    params.push(status);
  }
  
  sql += ` ORDER BY n.created_at DESC`;
  
  const { rows } = await query(sql, params);
  return rows;
}

export async function updateNcrDisposition(tenantId: string, id: string, data: NcrUpdateInput) {
  return withTransaction(async (client) => {
    const ncrResult = await client.query(
      'SELECT * FROM ncrs WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId]
    );
    if (ncrResult.rowCount === 0) throw new Error('NCR_NOT_FOUND');
    const ncr = ncrResult.rows[0];
    
    if (ncr.status === 'closed') throw new Error('NCR_ALREADY_CLOSED');

    // Update NCR
    const { rows } = await client.query(
      `UPDATE ncrs
          SET disposition_type = $1,
              disposition_notes = $2,
              status = 'closed',
              updated_at = now()
        WHERE id = $3 AND tenant_id = $4
        RETURNING *`,
      [data.dispositionType, data.dispositionNotes ?? null, id, tenantId]
    );

    // Note: Actual inventory movement for disposition (e.g. Scrap, RTV) 
    // should be handled here or triggered separately. 
    // For now, we just record the decision.
    // Implementing the actual movement would require knowing where the inventory is (MRB location)
    // and moving it to Scrap, or creating a Return to Vendor shipment, etc.
    
    return rows[0];
  });
}
