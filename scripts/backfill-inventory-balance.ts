import { pool } from '../src/db';

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 1000);
const TENANT_ID = process.env.TENANT_ID ?? null;

async function fetchTenants(): Promise<string[]> {
  if (TENANT_ID) return [TENANT_ID];
  const { rows } = await pool.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM inventory_movement_lines'
  );
  return rows.map((r) => r.tenant_id);
}

async function countKeys(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `WITH ledger AS (
       SELECT item_id,
              location_id,
              COALESCE(canonical_uom, uom) AS uom
         FROM inventory_movement_lines
        WHERE tenant_id = $1
        GROUP BY item_id, location_id, COALESCE(canonical_uom, uom)
     ),
     reserved AS (
       SELECT r.item_id,
              r.location_id,
              COALESCE(i.canonical_uom, r.uom) AS uom
         FROM inventory_reservations r
         JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1
        GROUP BY r.item_id, r.location_id, COALESCE(i.canonical_uom, r.uom)
     ),
     combined AS (
       SELECT COALESCE(l.item_id, r.item_id) AS item_id,
              COALESCE(l.location_id, r.location_id) AS location_id,
              COALESCE(l.uom, r.uom) AS uom
         FROM ledger l
         FULL OUTER JOIN reserved r
           ON l.item_id = r.item_id
          AND l.location_id = r.location_id
          AND l.uom = r.uom
     )
     SELECT COUNT(*)::text AS count FROM combined`,
    [tenantId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function backfillTenant(tenantId: string) {
  const total = await countKeys(tenantId);
  let offset = 0;
  let processed = 0;

  while (offset < total) {
    const { rows } = await pool.query(
      `WITH ledger AS (
         SELECT item_id,
                location_id,
                COALESCE(canonical_uom, uom) AS uom,
                SUM(COALESCE(quantity_delta_canonical, quantity_delta)) AS on_hand
           FROM inventory_movement_lines
          WHERE tenant_id = $1
          GROUP BY item_id, location_id, COALESCE(canonical_uom, uom)
       ),
       reserved AS (
         SELECT r.item_id,
                r.location_id,
                COALESCE(i.canonical_uom, r.uom) AS uom,
                SUM(r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0)) AS reserved
           FROM inventory_reservations r
           JOIN items i ON i.id = r.item_id AND i.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1
            AND r.status IN ('open', 'released')
            AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
          GROUP BY r.item_id, r.location_id, COALESCE(i.canonical_uom, r.uom)
       ),
       combined AS (
         SELECT COALESCE(l.item_id, r.item_id) AS item_id,
                COALESCE(l.location_id, r.location_id) AS location_id,
                COALESCE(l.uom, r.uom) AS uom,
                COALESCE(l.on_hand, 0) AS on_hand,
                COALESCE(r.reserved, 0) AS reserved
           FROM ledger l
           FULL OUTER JOIN reserved r
             ON l.item_id = r.item_id
            AND l.location_id = r.location_id
            AND l.uom = r.uom
       ),
       page AS (
         SELECT * FROM combined
          ORDER BY item_id, location_id, uom
          LIMIT $2 OFFSET $3
       )
       INSERT INTO inventory_balance (
         tenant_id, item_id, location_id, uom, on_hand, reserved, created_at, updated_at
       )
       SELECT $1, item_id, location_id, uom, on_hand, reserved, now(), now()
         FROM page
       ON CONFLICT (tenant_id, item_id, location_id, uom)
       DO UPDATE SET
         on_hand = EXCLUDED.on_hand,
         reserved = EXCLUDED.reserved,
         updated_at = now()
       RETURNING item_id`,
      [tenantId, BATCH_SIZE, offset]
    );

    processed += rows.length;
    offset += BATCH_SIZE;
    if (rows.length === 0) break;
  }

  console.log(`[inventory_balance] tenant=${tenantId} processed=${processed}`);
}

async function main() {
  const tenants = await fetchTenants();
  for (const tenantId of tenants) {
    await backfillTenant(tenantId);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[inventory_balance] backfill failed', err);
  process.exit(1);
});
