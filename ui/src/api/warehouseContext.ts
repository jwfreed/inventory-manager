import { apiGet } from './http'

type LocationLike = {
  id: string
  type?: string
  warehouseId?: string | null
  warehouse_id?: string | null
}

let defaultWarehouseId: string | null = null
const warehouseByLocation = new Map<string, string>()

function extractWarehouseId(location: LocationLike | null | undefined): string | null {
  if (!location) return null
  const resolved = location.warehouseId ?? location.warehouse_id ?? null
  if (resolved) return resolved
  if (location.type === 'warehouse') return location.id
  return null
}

export async function resolveWarehouseId(params: {
  warehouseId?: string
  locationId?: string
} = {}): Promise<string> {
  if (params.warehouseId) return params.warehouseId

  if (params.locationId) {
    const cached = warehouseByLocation.get(params.locationId)
    if (cached) return cached

    const location = await apiGet<LocationLike>(`/locations/${params.locationId}`)
    const fromLocation = extractWarehouseId(location)
    if (fromLocation) {
      warehouseByLocation.set(params.locationId, fromLocation)
      defaultWarehouseId = defaultWarehouseId ?? fromLocation
      return fromLocation
    }
  }

  if (defaultWarehouseId) return defaultWarehouseId

  const warehousesRes = await apiGet<{ data?: LocationLike[] } | LocationLike[]>('/locations', {
    params: { type: 'warehouse', active: true, limit: 1, offset: 0 }
  })
  const first = Array.isArray(warehousesRes) ? warehousesRes[0] : warehousesRes.data?.[0]
  const resolved = extractWarehouseId(first ?? null)
  if (!resolved) {
    throw new Error('WAREHOUSE_ID_REQUIRED')
  }
  defaultWarehouseId = resolved
  if (first?.id) {
    warehouseByLocation.set(first.id, resolved)
  }
  return resolved
}
