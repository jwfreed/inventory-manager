import { apiGet } from '../../../api/http'
import type { ReplenishmentPolicy, ReplenishmentRecommendation } from '../../../api/types'

type ReplenishmentPoliciesResponse = { data?: ReplenishmentPolicy[] } | ReplenishmentPolicy[]

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

export async function listReplenishmentPolicies(params: { limit?: number; offset?: number } = {}) {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const response = await apiGet<ReplenishmentPoliciesResponse>('/replenishment/policies', { params: query })
  if (Array.isArray(response)) return { data: response }
  return { data: response.data ?? [] }
}

export async function listAllReplenishmentPolicies(pageSize = 200) {
  const all: ReplenishmentPolicy[] = []
  let offset = 0
  while (true) {
    const page = await listReplenishmentPolicies({ limit: pageSize, offset })
    all.push(...page.data)
    if (page.data.length < pageSize) break
    offset += pageSize
    if (offset > 20_000) break
  }
  return { data: all }
}
