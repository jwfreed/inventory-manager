import { apiGet } from '../http'
import type { ReplenishmentRecommendation } from '../types'

export async function listReplenishmentRecommendations(params: { limit?: number; offset?: number } = {}) {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const response = await apiGet<{ data?: ReplenishmentRecommendation[] } | ReplenishmentRecommendation[]>(
    '/replenishment/recommendations',
    { params: query }
  )
  if (Array.isArray(response)) return { data: response }
  return { data: response.data ?? [] }
}
