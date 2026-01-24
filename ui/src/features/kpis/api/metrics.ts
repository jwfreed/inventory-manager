import { apiPost } from '../../../api/http'

export type ComputeAllMetricsResponse = {
  success?: boolean
  message?: string
  results?: {
    abcUpdated?: number
    slowDeadUpdated?: number
    turnsDoiRunId?: string
    runId?: string
  }
}

export async function computeAllMetrics() {
  return apiPost<ComputeAllMetricsResponse>('/metrics/compute/all', {})
}
