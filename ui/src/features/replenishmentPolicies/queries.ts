import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, ReplenishmentPolicy } from '@api/types'
import {
  getReplenishmentPolicy,
  listReplenishmentPolicies,
} from './api'

type ReplenishmentPoliciesListResult = Awaited<ReturnType<typeof listReplenishmentPolicies>>
type ReplenishmentPolicyDetailResult = Awaited<ReturnType<typeof getReplenishmentPolicy>>

export const replenishmentPolicyQueryKeys = {
  prefix: () => ['planning', 'replenishment-policies'] as const,
  list: (params: { limit?: number; offset?: number } = {}) =>
    ['planning', 'replenishment-policies', params] as const,
  detail: (id: string) => ['planning', 'replenishment-policies', 'detail', id] as const,
}

type ReplenishmentPoliciesListOptions = Omit<
  UseQueryOptions<ReplenishmentPoliciesListResult, ApiError>,
  'queryKey' | 'queryFn'
>

type ReplenishmentPolicyDetailOptions = Omit<
  UseQueryOptions<ReplenishmentPolicyDetailResult, ApiError>,
  'queryKey' | 'queryFn'
>

export function useReplenishmentPoliciesList(
  params: { limit?: number; offset?: number } = {},
  options: ReplenishmentPoliciesListOptions = {},
) {
  return useQuery({
    queryKey: replenishmentPolicyQueryKeys.list(params),
    queryFn: () => listReplenishmentPolicies(params),
    retry: 1,
    ...options,
  })
}

export function useReplenishmentPolicy(
  id?: string,
  options: ReplenishmentPolicyDetailOptions = {},
) {
  return useQuery({
    queryKey: replenishmentPolicyQueryKeys.detail(id ?? ''),
    queryFn: () => getReplenishmentPolicy(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}
