import { apiGet, apiPost } from '@api/http'
import type { ReplenishmentPolicy } from '@api/types'

type ReplenishmentPoliciesResponse =
  | { data?: ReplenishmentPolicy[]; paging?: { limit: number; offset: number; total?: number } }
  | ReplenishmentPolicy[]

export type ReplenishmentPolicyInput = {
  itemId: string
  uom: string
  siteLocationId?: string | null
  policyType: 'q_rop' | 'min_max'
  status?: 'active' | 'inactive'
  leadTimeDays?: number
  demandRatePerDay?: number
  safetyStockMethod: 'none' | 'fixed' | 'ppis'
  safetyStockQty?: number
  ppisPeriods?: number
  orderUpToLevelQty?: number
  reorderPointQty?: number
  orderQuantityQty?: number
  minOrderQty?: number
  maxOrderQty?: number
  notes?: string
}

export async function listReplenishmentPolicies(params: { limit?: number; offset?: number } = {}) {
  const query: Record<string, number> = {}
  if (params.limit) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const response = await apiGet<ReplenishmentPoliciesResponse>('/replenishment/policies', { params: query })
  if (Array.isArray(response)) return { data: response, paging: undefined }
  return { data: response.data ?? [], paging: response.paging }
}

export async function getReplenishmentPolicy(id: string) {
  return apiGet<ReplenishmentPolicy>(`/replenishment/policies/${id}`)
}

export async function createReplenishmentPolicy(payload: ReplenishmentPolicyInput) {
  return apiPost<ReplenishmentPolicy>('/replenishment/policies', payload)
}
