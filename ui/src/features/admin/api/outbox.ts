import { apiPost } from '../../../api/http'

export async function processOutboxBatch(limit: number = 50): Promise<{ processed: number }> {
  return apiPost('/admin/outbox/process', { limit })
}
