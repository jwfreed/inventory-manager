import { apiGet, apiPost, apiPut } from '../../../api/http'
import type { Item, ItemInventoryRow } from '../../../api/types'

type ItemApiRow = Item & {
  type?: Item['type']
  default_uom?: string | null
  default_location_id?: string | null
  default_location_code?: string | null
  default_location_name?: string | null
  standard_cost?: number | null
  standard_cost_currency?: string | null
  standard_cost_exchange_rate_to_base?: number | null
  standard_cost_base?: number | null
  average_cost?: number | null
  rolled_cost?: number | null
  rolled_cost_at?: string | null
  cost_method?: Item['costMethod'] | null
  selling_price?: number | null
  list_price?: number | null
  price_currency?: string | null
  created_at?: string
  updated_at?: string
}

export type ItemPayload = {
  sku: string
  name: string
  description?: string
  type?: Item['type']
  isPhantom?: boolean
  lifecycleStatus?: Item['lifecycleStatus']
  defaultUom?: string | null
  defaultLocationId?: string | null
  standardCost?: number
  standardCostCurrency?: string | null
}

export type ItemMetrics = {
  itemId: string
  windowDays: number
  orderedQty: number
  shippedQty: number
  fillRate: number | null
  stockoutRate: number | null
  totalOutflowQty: number
  avgOnHandQty: number
  turns: number | null
  doiDays: number | null
  lastCountAt: string | null
  lastCountVarianceQty: number | null
  lastCountVariancePct: number | null
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
    isPhantom: !!row.isPhantom,
    lifecycleStatus: row.lifecycleStatus,
    defaultUom: row.defaultUom ?? row.default_uom ?? null,
    defaultLocationId: row.defaultLocationId ?? row.default_location_id ?? null,
    defaultLocationCode: row.defaultLocationCode ?? row.default_location_code ?? null,
    defaultLocationName: row.defaultLocationName ?? row.default_location_name ?? null,
    standardCost: row.standardCost ?? row.standard_cost ?? null,
    standardCostCurrency: row.standardCostCurrency ?? row.standard_cost_currency ?? null,
    standardCostExchangeRateToBase:
      row.standardCostExchangeRateToBase ?? row.standard_cost_exchange_rate_to_base ?? null,
    standardCostBase: row.standardCostBase ?? row.standard_cost_base ?? null,
    averageCost: row.averageCost ?? row.average_cost ?? null,
    rolledCost: row.rolledCost ?? row.rolled_cost ?? null,
    rolledCostAt: row.rolledCostAt ?? row.rolled_cost_at ?? null,
    costMethod: row.costMethod ?? row.cost_method ?? null,
    sellingPrice: row.sellingPrice ?? row.selling_price ?? null,
    listPrice: row.listPrice ?? row.list_price ?? null,
    priceCurrency: row.priceCurrency ?? row.price_currency ?? null,
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

export async function getItemMetrics(id: string, windowDays?: number): Promise<ItemMetrics> {
  const params = new URLSearchParams()
  if (windowDays) params.set('windowDays', String(windowDays))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return apiGet<ItemMetrics>(`/items/${id}/metrics${suffix}`)
}
