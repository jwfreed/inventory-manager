import { apiGet, apiPost, apiPut } from '../../../api/http'
import type { Location, LocationInventoryRow } from '../../../api/types'

type LocationApiRow = Location & {
  parent_location_id?: string | null
  created_at?: string
  updated_at?: string
}

export type LocationPayload = {
  code: string
  name: string
  type: string
  active?: boolean
  parentLocationId?: string | null
}

export type ListLocationsParams = {
  type?: string
  active?: boolean
  search?: string
  limit?: number
  offset?: number
}

function mapLocation(row: LocationApiRow): Location {
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

export async function createLocation(payload: LocationPayload): Promise<Location> {
  const location = await apiPost<Location>('/locations', payload)
  return mapLocation(location)
}

export async function updateLocation(id: string, payload: LocationPayload): Promise<Location> {
  const location = await apiPut<Location>(`/locations/${id}`, payload)
  return mapLocation(location)
}

export async function createStandardWarehouseTemplate(opts: { includeReceivingQc?: boolean } = {}): Promise<{
  created: Location[]
  skipped: string[]
}> {
  const response = await apiPost<{ created?: LocationApiRow[]; skipped?: string[] }>(
    '/locations/templates/standard-warehouse',
    { includeReceivingQc: opts.includeReceivingQc },
  )
  return {
    created: (response.created ?? []).map(mapLocation),
    skipped: response.skipped ?? [],
  }
}
