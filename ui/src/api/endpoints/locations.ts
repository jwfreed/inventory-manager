import { apiGet } from '../http'
import type { Location, LocationInventoryRow } from '../types'

export type ListLocationsParams = {
  type?: string
  active?: boolean
}

export async function listLocations(params: ListLocationsParams = {}): Promise<{ data: Location[] }> {
  const searchParams: Record<string, string | boolean> = {}
  if (params.type) searchParams.type = params.type
  if (params.active !== undefined) searchParams.active = params.active

  const response = await apiGet<{ data?: Location[] } | Location[]>('/locations', {
    params: Object.keys(searchParams).length ? searchParams : undefined,
  })
  if (Array.isArray(response)) return { data: response }
  if (!response?.data) return { data: [] }
  return { data: response.data }
}

export async function getLocation(id: string): Promise<Location> {
  return apiGet<Location>(`/locations/${id}`)
}

export async function getLocationInventorySummary(id: string): Promise<LocationInventoryRow[]> {
  const response = await apiGet<LocationInventoryRow[] | { data?: LocationInventoryRow[] }>(
    `/locations/${id}/inventory`,
  )
  if (Array.isArray(response)) return response
  return response.data ?? []
}
