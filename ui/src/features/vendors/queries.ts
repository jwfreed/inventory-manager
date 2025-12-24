import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Vendor } from '../../api/types'
import { listVendors } from './api/vendors'

export const vendorsQueryKeys = {
  all: ['vendors'] as const,
  list: (params: { limit?: number; active?: boolean } = {}) =>
    [...vendorsQueryKeys.all, 'list', params] as const,
}

type VendorsListOptions = Omit<
  UseQueryOptions<{ data: Vendor[] }, ApiError>,
  'queryKey' | 'queryFn'
>

export function useVendorsList(
  params: { limit?: number; active?: boolean } = {},
  options: VendorsListOptions = {},
) {
  return useQuery({
    queryKey: vendorsQueryKeys.list(params),
    queryFn: () => listVendors(params),
    retry: 1,
    ...options,
  })
}
