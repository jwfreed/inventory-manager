import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { ApiError, Location, LocationInventoryRow } from '../../api/types'
import {
  getLocation,
  getLocationInventorySummary,
  listLocations,
  type ListLocationsParams,
} from './api/locations'

export const locationsQueryKeys = {
  all: ['locations'] as const,
  list: (params: ListLocationsParams = {}) => [...locationsQueryKeys.all, 'list', params] as const,
  detail: (id: string) => [...locationsQueryKeys.all, 'detail', id] as const,
  inventorySummary: (id: string) => [...locationsQueryKeys.all, 'inventory-summary', id] as const,
}

type LocationsListOptions = Omit<
  UseQueryOptions<{ data: Location[] }, ApiError>,
  'queryKey' | 'queryFn'
>

type LocationOptions = Omit<UseQueryOptions<Location, ApiError>, 'queryKey' | 'queryFn'>

type LocationInventoryOptions = Omit<
  UseQueryOptions<LocationInventoryRow[], ApiError>,
  'queryKey' | 'queryFn'
>

export function useLocationsList(params: ListLocationsParams = {}, options: LocationsListOptions = {}) {
  return useQuery({
    queryKey: locationsQueryKeys.list(params),
    queryFn: () => listLocations(params),
    retry: 1,
    ...options,
  })
}

export function useLocation(id?: string, options: LocationOptions = {}) {
  return useQuery({
    queryKey: locationsQueryKeys.detail(id ?? ''),
    queryFn: () => getLocation(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}

export function useLocationInventorySummary(id?: string, options: LocationInventoryOptions = {}) {
  return useQuery({
    queryKey: locationsQueryKeys.inventorySummary(id ?? ''),
    queryFn: () => getLocationInventorySummary(id as string),
    enabled: Boolean(id),
    retry: 1,
    ...options,
  })
}
