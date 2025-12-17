import { apiGet, apiPost, apiPut } from '../http'
import type { Item, ItemInventoryRow } from '../types'

type ItemApiRow = Item & {
  created_at?: string
  updated_at?: string
}

export type ItemPayload = {
  sku: string
  name: string
  description?: string
  active?: boolean
}

export type ListItemsParams = {
  active?: boolean
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
    active: row.active,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  }
}

export async function listItems(params: ListItemsParams = {}): Promise<{ data: Item[] }> {
  const response = await apiGet<{ data?: Item[] } | Item[]>('/items', {
    params: {
      ...(params.active !== undefined ? { active: params.active } : {}),
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
  return apiGet<Item>(`/items/${id}`)
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
