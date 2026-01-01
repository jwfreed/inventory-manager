import { apiGet, apiPost, apiPut } from '../../../api/http'
import type { Item, ItemInventoryRow } from '../../../api/types'

type ItemApiRow = Item & {
  type?: Item['type']
  default_uom?: string | null
  default_location_id?: string | null
  default_location_code?: string | null
  default_location_name?: string | null
  created_at?: string
  updated_at?: string
}

export type ItemPayload = {
  sku: string
  name: string
  description?: string
  type?: Item['type']
  lifecycleStatus?: Item['lifecycleStatus']
  defaultUom?: string | null
  defaultLocationId?: string | null
}

export type ListItemsParams = {
  lifecycleStatus?: string
  search?: string
  limit?: number
  offset?: number
}

function mapItem(row: ItemApiRow): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    type: row.type ?? 'raw',
    lifecycleStatus: row.lifecycleStatus,
    defaultUom: row.defaultUom ?? row.default_uom ?? null,
    defaultLocationId: row.defaultLocationId ?? row.default_location_id ?? null,
    defaultLocationCode: row.defaultLocationCode ?? row.default_location_code ?? null,
    defaultLocationName: row.defaultLocationName ?? row.default_location_name ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

export async function listItems(params: ListItemsParams = {}): Promise<{ data: Item[] }> {
  const response = await apiGet<{ data?: Item[] } | Item[]>('/items', {
    params: {
      ...(params.lifecycleStatus ? { lifecycleStatus: params.lifecycleStatus } : {}),
      ...(params.search ? { search: params.search } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    },
  })
  if (Array.isArray(response)) return { data: response.map(mapItem) }
  if (!response?.data) return { data: [] }
  return { data: response.data.map(mapItem) }
}

export async function getItem(id: string): Promise<Item> {
  const item = await apiGet<ItemApiRow>(`/items/${id}`)
  return mapItem(item)
}

export async function getItemInventorySummary(id: string): Promise<ItemInventoryRow[]> {
  const response = await apiGet<ItemInventoryRow[] | { data?: ItemInventoryRow[] }>(
    `/items/${id}/inventory`,
  )
  if (Array.isArray(response)) return response
  return response.data ?? []
}

export async function createItem(payload: ItemPayload): Promise<Item> {
  const item = await apiPost<Item>('/items', payload)
  return mapItem(item)
}

export async function updateItem(id: string, payload: ItemPayload): Promise<Item> {
  const item = await apiPut<Item>(`/items/${id}`, payload)
  return mapItem(item)
}
