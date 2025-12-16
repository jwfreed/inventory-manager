import { apiGet } from '../http'
import type { Item, ItemInventoryRow } from '../types'

export type ListItemsParams = {
  active?: boolean
}

export async function listItems(params: ListItemsParams = {}): Promise<{ data: Item[] }> {
  // Backend may ignore filters; we still pass active if present
  const response = await apiGet<{ data?: Item[] } | Item[]>('/items', {
    params: params.active === undefined ? undefined : { active: params.active },
  })
  if (Array.isArray(response)) return { data: response }
  if (!response?.data) return { data: [] }
  return { data: response.data }
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
