import { useMemo } from 'react'
import type { Item, WorkOrder } from '../../../api/types'

export function useWorkOrdersListData(workOrders: WorkOrder[], items: Item[], search: string) {
  const itemLookup = useMemo(() => {
    const map = new Map<string, { name?: string; sku?: string }>()
    items.forEach((item) => {
      map.set(item.id, { name: item.name, sku: item.sku })
    })
    return map
  }, [items])

  const filtered = useMemo(() => {
    if (!search) return workOrders
    const needle = search.toLowerCase()
    return workOrders.filter((wo) => {
      const lookup = itemLookup.get(wo.outputItemId)
      const hay = `${wo.number ?? ''} ${wo.description ?? ''} ${wo.outputItemSku ?? ''} ${wo.outputItemName ?? ''} ${lookup?.name ?? ''} ${lookup?.sku ?? ''} ${wo.outputItemId}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [workOrders, search, itemLookup])

  const remaining = (wo: WorkOrder) =>
    Math.max(0, (wo.quantityPlanned || 0) - (wo.quantityCompleted ?? 0))

  const formatOutput = (wo: WorkOrder) => {
    const lookup = wo.outputItemId ? itemLookup.get(wo.outputItemId) : undefined
    const name = wo.outputItemName || lookup?.name
    const sku = wo.outputItemSku || lookup?.sku
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return wo.outputItemId
  }

  return {
    filtered,
    remaining,
    formatOutput,
  }
}
