import { useMemo } from 'react'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'

export type CommandAction = {
  id: string
  label: string
  meta?: string
  group: 'Navigate' | 'Items' | 'Work Orders' | 'Locations' | 'Inventory'
  run: () => void
}

type Params = {
  query: string
  navigate: (to: string) => void
}

const MAX_RESULTS = 8

export function useCommandRegistry({ query, navigate }: Params) {
  const normalizedQuery = query.trim().toLowerCase()
  const itemsQuery = useItemsList(
    { search: normalizedQuery || undefined, limit: MAX_RESULTS },
    { enabled: normalizedQuery.length > 0, staleTime: 30_000 },
  )
  const locationsQuery = useLocationsList(
    { search: normalizedQuery || undefined, limit: MAX_RESULTS },
    { enabled: normalizedQuery.length > 0, staleTime: 30_000 },
  )
  const workOrdersQuery = useWorkOrdersList({ limit: 50 }, { staleTime: 30_000 })

  const commands = useMemo(() => {
    const staticCommands: CommandAction[] = [
      {
        id: 'nav-items',
        label: 'Open items',
        meta: '/items',
        group: 'Navigate',
        run: () => navigate('/items'),
      },
      {
        id: 'nav-work-orders',
        label: 'Open work orders',
        meta: '/work-orders',
        group: 'Navigate',
        run: () => navigate('/work-orders'),
      },
      {
        id: 'nav-movements',
        label: 'View movements',
        meta: '/movements',
        group: 'Inventory',
        run: () => navigate('/movements'),
      },
      {
        id: 'nav-locations',
        label: 'Open locations',
        meta: '/locations',
        group: 'Navigate',
        run: () => navigate('/locations'),
      },
      {
        id: 'action-adjust-stock',
        label: 'Adjust stock',
        meta: '/inventory-adjustments/new',
        group: 'Inventory',
        run: () => navigate('/inventory-adjustments/new'),
      },
      {
        id: 'action-create-work-order',
        label: 'Create work order',
        meta: '/work-orders/new',
        group: 'Work Orders',
        run: () => navigate('/work-orders/new'),
      },
    ]

    const itemCommands =
      itemsQuery.data?.data.map((item) => ({
        id: `item:${item.id}`,
        label: `Open item ${item.sku}`,
        meta: item.name,
        group: 'Items' as const,
        run: () => navigate(`/items/${item.id}`),
      })) ?? []

    const locationCommands =
      locationsQuery.data?.data.map((location) => ({
        id: `location:${location.id}`,
        label: `Open location ${location.code}`,
        meta: location.name,
        group: 'Locations' as const,
        run: () => navigate(`/locations/${location.id}`),
      })) ?? []

    const workOrderCommands =
      workOrdersQuery.data?.data
        ?.filter((workOrder) => {
          if (!normalizedQuery) return false
          const haystack = [
            workOrder.number,
            workOrder.status,
            workOrder.kind,
            workOrder.outputItemId,
          ]
            .join(' ')
            .toLowerCase()
          return haystack.includes(normalizedQuery)
        })
        .slice(0, MAX_RESULTS)
        .map((workOrder) => ({
          id: `work-order:${workOrder.id}`,
          label: `Open work order ${workOrder.number}`,
          meta: `${workOrder.kind} • ${workOrder.status}`,
          group: 'Work Orders' as const,
          run: () => navigate(`/work-orders/${workOrder.id}`),
        })) ?? []

    const filteredStaticCommands = normalizedQuery
      ? staticCommands.filter((command) =>
          `${command.label} ${command.meta ?? ''}`.toLowerCase().includes(normalizedQuery),
        )
      : staticCommands

    return [
      ...filteredStaticCommands,
      ...itemCommands,
      ...workOrderCommands,
      ...locationCommands,
    ].slice(0, 20)
  }, [
    itemsQuery.data?.data,
    locationsQuery.data?.data,
    navigate,
    normalizedQuery,
    workOrdersQuery.data?.data,
  ])

  return {
    commands,
    isLoading:
      itemsQuery.isFetching || locationsQuery.isFetching || workOrdersQuery.isFetching,
  }
}
