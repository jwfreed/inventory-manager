import { apiGet } from '../http'
import type { Location, LocationInventoryRow } from '../types'

export type ListLocationsParams = {
  type?: string
  active?: boolean
  search?: string
  limit?: number
  offset?: number
}

function mapLocation(row: any): Location {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    active: row.active,
    parentLocationId: row.parentLocationId ?? row.parent_location_id,
    path: row.path,
    depth: row.depth,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

export async function listLocations(params: ListLocationsParams = {}): Promise<{ data: Location[] }> {
  const response = await apiGet<{ data?: Location[] } | Location[]>('/locations', {
    params: {
      ...(params.type ? { type: params.type } : {}),
      ...(params.active !== undefined ? { active: params.active } : {}),
      ...(params.search ? { search: params.search } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    },
  })
  if (Array.isArray(response)) return { data: response.map(mapLocation) }
  if (!response?.data) return { data: [] }
  return { data: response.data.map(mapLocation) }
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
