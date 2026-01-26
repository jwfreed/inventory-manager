import { pool } from '../src/db';
import { getCanonicalMovementFields } from '../src/services/uomCanonical.service';

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 200);
const TENANT_ID = process.env.TENANT_ID ?? null;

type MovementRow = {
  id: string;
  tenant_id: string;
  item_id: string;
  quantity_delta: string | number;
  uom: string;
};

async function backfillTenant(tenantId: string) {
  let processed = 0;
  while (true) {
    const { rows } = await pool.query<MovementRow>(
      `SELECT id, tenant_id, item_id, quantity_delta, uom
         FROM inventory_movement_lines
        WHERE tenant_id = $1
          AND quantity_delta_canonical IS NULL
        ORDER BY created_at ASC
        LIMIT $2`,
      [tenantId, BATCH_SIZE]
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const canonical = await getCanonicalMovementFields(
          tenantId,
          row.item_id,
          Number(row.quantity_delta),
          row.uom
        );
        await pool.query(
          `UPDATE inventory_movement_lines
              SET quantity_delta_entered = $1,
                  uom_entered = $2,
                  quantity_delta_canonical = $3,
                  canonical_uom = $4,
                  uom_dimension = $5
            WHERE id = $6 AND tenant_id = $7`,
          [
            canonical.quantityDeltaEntered,
            canonical.uomEntered,
            canonical.quantityDeltaCanonical,
            canonical.canonicalUom,
            canonical.uomDimension,
            row.id,
            tenantId
          ]
        );
        processed += 1;
      } catch (err) {
        console.warn(
          `[backfill] skip movement_line=${row.id} item=${row.item_id} uom=${row.uom}: ${(err as Error).message}`
        );
      }
    }
  }
  return processed;
}

async function main() {
  const tenantIds = TENANT_ID
    ? [TENANT_ID]
    : (
        await pool.query<{ tenant_id: string }>(
          'SELECT DISTINCT tenant_id FROM inventory_movement_lines WHERE quantity_delta_canonical IS NULL'
        )
      ).rows.map((row) => row.tenant_id);

  let total = 0;
  for (const tenantId of tenantIds) {
    const processed = await backfillTenant(tenantId);
    total += processed;
  }

  console.log(`[backfill] completed. updated=${total}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill] failed', err);
  process.exit(1);
});
