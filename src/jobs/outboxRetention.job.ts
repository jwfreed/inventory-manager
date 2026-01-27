import { query } from '../db';

export async function pruneOutboxEvents(): Promise<{ deleted: number; retentionDays: number }> {
  const retentionDaysRaw = Number(process.env.OUTBOX_RETENTION_DAYS ?? 7);
  const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(2, retentionDaysRaw) : 7;
  const batchSizeRaw = Number(process.env.OUTBOX_RETENTION_BATCH ?? 1000);
  const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(1, batchSizeRaw) : 1000;
  const maxBatchesRaw = Number(process.env.OUTBOX_RETENTION_MAX_BATCHES ?? 10);
  const maxBatches = Number.isFinite(maxBatchesRaw) ? Math.max(1, maxBatchesRaw) : 10;

  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const res = await query(
      `WITH to_delete AS (
          SELECT id
            FROM outbox_events
           WHERE created_at < (now() - ($1::int || ' days')::interval)
           ORDER BY created_at ASC
           LIMIT $2
        )
        DELETE FROM outbox_events
         WHERE id IN (SELECT id FROM to_delete)
        RETURNING 1`,
      [retentionDays, batchSize]
    );

    deleted += res.rowCount;
    if (res.rowCount < batchSize) {
      break;
    }
  }

  return { deleted, retentionDays };
}
