import { useMemo } from 'react'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { useWorkOrdersList } from '@features/workOrders/queries'
import { useAuth } from '@shared/auth'

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

function looksLikeEntityQuery(query: string) {
  if (!query) return false
  return /[0-9-]/.test(query) || /^wo[\s-]?\d+/i.test(query) || /^[a-z]{1,4}\d+/i.test(query)
}

function scoreCommand(command: CommandAction, normalizedQuery: string) {
  if (!normalizedQuery) return 0
  const haystack = `${command.label} ${command.meta ?? ''}`.toLowerCase()
  const isEntityCommand = command.id.startsWith('item:') || command.id.startsWith('work-order:') || command.id.startsWith('location:')
  let score = 0

  if (haystack.startsWith(normalizedQuery)) score += 50
  else if (haystack.includes(normalizedQuery)) score += 25

  if (command.meta?.toLowerCase().startsWith(normalizedQuery)) score += 20

  if (looksLikeEntityQuery(normalizedQuery) && isEntityCommand) score += 100
  else if (isEntityCommand) score += 10

  if (command.group === 'Navigate') score -= 5

  return score
}

export function useCommandRegistry({ query, navigate }: Params) {
  const { hasPermission } = useAuth()
  const normalizedQuery = query.trim().toLowerCase()
  const canReadMasterData = hasPermission('masterdata:read')
  const canReadProduction = hasPermission('production:read')
  const canReadInventory = hasPermission('inventory:read')
  const canWriteAdjustments = hasPermission('inventory:adjustments:write')
  const canWriteProduction = hasPermission('production:write')
  const itemsQuery = useItemsList(
    { search: normalizedQuery || undefined, limit: MAX_RESULTS },
    { enabled: canReadMasterData && normalizedQuery.length > 0, staleTime: 30_000 },
  )
  const locationsQuery = useLocationsList(
    { search: normalizedQuery || undefined, limit: MAX_RESULTS },
    { enabled: canReadMasterData && normalizedQuery.length > 0, staleTime: 30_000 },
  )
  const workOrdersQuery = useWorkOrdersList({ limit: 50 }, { enabled: canReadProduction, staleTime: 30_000 })

  const commands = useMemo(() => {
    const staticCommands: CommandAction[] = [
      canReadMasterData && {
        id: 'nav-items',
        label: 'Open items',
        meta: '/items',
        group: 'Navigate',
        run: () => navigate('/items'),
      },
      canReadProduction && {
        id: 'nav-work-orders',
        label: 'Open work orders',
        meta: '/work-orders',
        group: 'Navigate',
        run: () => navigate('/work-orders'),
      },
      canReadInventory && {
        id: 'nav-movements',
        label: 'View movements',
        meta: '/movements',
        group: 'Inventory',
        run: () => navigate('/movements'),
      },
      canReadMasterData && {
        id: 'nav-locations',
        label: 'Open locations',
        meta: '/locations',
        group: 'Navigate',
        run: () => navigate('/locations'),
      },
      canWriteAdjustments && {
        id: 'action-adjust-stock',
        label: 'Adjust stock',
        meta: '/inventory-adjustments/new',
        group: 'Inventory',
        run: () => navigate('/inventory-adjustments/new'),
      },
      canWriteProduction && {
        id: 'action-create-work-order',
        label: 'Create work order',
        meta: '/work-orders/new',
        group: 'Work Orders',
        run: () => navigate('/work-orders/new'),
      },
    ].filter((command): command is CommandAction => Boolean(command))

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
    ]
      .sort((left, right) => scoreCommand(right, normalizedQuery) - scoreCommand(left, normalizedQuery))
      .slice(0, 20)
  }, [
    itemsQuery.data?.data,
    locationsQuery.data?.data,
    canReadInventory,
    canReadMasterData,
    canReadProduction,
    canWriteAdjustments,
    canWriteProduction,
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
