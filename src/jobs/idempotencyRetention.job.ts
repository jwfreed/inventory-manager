import { query } from '../db';

export async function pruneIdempotencyKeys(): Promise<{ deleted: number; retentionDays: number }> {
  const retentionDaysRaw = Number(process.env.IDEMPOTENCY_RETENTION_DAYS ?? 7);
  const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(1, Math.floor(retentionDaysRaw)) : 7;
  const batchSizeRaw = Number(process.env.IDEMPOTENCY_RETENTION_BATCH ?? 5000);
  const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(1, Math.floor(batchSizeRaw)) : 5000;

  let deletedTotal = 0;
  while (true) {
    const result = await query<{ deleted: number }>(
      `WITH to_delete AS (
          SELECT tenant_id, key
            FROM idempotency_keys
           WHERE created_at < (now() - ($1::int || ' days')::interval)
           ORDER BY created_at ASC
           LIMIT $2
        )
        DELETE FROM idempotency_keys ik
         USING to_delete td
         WHERE ik.tenant_id = td.tenant_id
           AND ik.key = td.key
        RETURNING 1`,
      [retentionDays, batchSize]
    );
    deletedTotal += result.rowCount;
    if (result.rowCount === 0) {
      break;
    }
  }

  return {
    deleted: deletedTotal,
    retentionDays
  };
}
