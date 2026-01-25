import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { buildUrl } from '../api/baseUrl'

type ServerEvent = {
  id: string
  type: string
  occurredAt: string
  data?: Record<string, unknown>
}

const EVENT_TYPES = [
  'system.ready',
  'inventory.adjustment.posted',
  'inventory.count.posted',
  'inventory.putaway.posted',
  'inventory.receipt.created',
  'inventory.receipt.deleted',
  'inventory.changed',
  'inventory.work_order.issue.posted',
  'inventory.work_order.completion.posted',
  'inventory.work_order.batch.posted',
  'inventory.reservation.created',
  'inventory.purchase_order.created',
  'inventory.purchase_order.updated',
  'inventory.purchase_order.deleted',
  'metrics:updated',
  'production:changed',
  'workorder:completed',
] as const

function asStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string' && entry.length > 0) as string[]
  }
  if (typeof value === 'string') return value ? [value] : []
  return []
}

function uniq(values: string[]) {
  return Array.from(new Set(values))
}

export function useServerEvents(accessToken?: string | null) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    if (!accessToken) return

    const rawUrl = buildUrl('/events')
    const url = rawUrl.startsWith('http')
      ? new URL(rawUrl)
      : new URL(rawUrl, window.location.origin)
    url.searchParams.set('access_token', accessToken)
    const source = new EventSource(url.toString())

    const invalidateInventory = (itemIds: string[], locationIds: string[]) => {
      void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] })
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const [key, itemId, locationId] = query.queryKey as [
            string,
            string | undefined,
            string | undefined,
          ]
          if (key !== 'inventory-snapshot') return false
          if (itemIds.length && itemId && !itemIds.includes(itemId)) return false
          if (locationIds.length && locationId && !locationIds.includes(locationId)) return false
          return true
        },
      })
      if (locationIds.length) {
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const [key, locationId] = query.queryKey as [string, string | undefined]
            return key === 'location-inventory' && !!locationId && locationIds.includes(locationId)
          },
        })
      }
    }

    const invalidateMovements = (movementIds: string[]) => {
      void queryClient.invalidateQueries({
        predicate: (query) => (query.queryKey[0] as string) === 'movements',
      })
      movementIds.forEach((movementId) => {
        void queryClient.invalidateQueries({ queryKey: ['movement', movementId] })
        void queryClient.invalidateQueries({ queryKey: ['movementLines', movementId] })
        void queryClient.invalidateQueries({ queryKey: ['movement-lines', movementId] })
      })
    }

    const invalidateWorkOrders = (workOrderId?: string) => {
      void queryClient.invalidateQueries({
        predicate: (query) => (query.queryKey[0] as string) === 'work-orders',
      })
      void queryClient.invalidateQueries({ queryKey: ['production-summary'] })
      if (workOrderId) {
        void queryClient.invalidateQueries({ queryKey: ['work-order', workOrderId] })
        void queryClient.invalidateQueries({ queryKey: ['work-order-execution', workOrderId] })
      }
    }

    const invalidateReservations = (reservationIds: string[]) => {
      void queryClient.invalidateQueries({ queryKey: ['reservations'] })
      reservationIds.forEach((id) => {
        void queryClient.invalidateQueries({ queryKey: ['reservation', id] })
      })
    }

    const invalidateReceipts = (receiptId?: string, purchaseOrderId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ['recent-receipts'] })
      if (receiptId) {
        void queryClient.invalidateQueries({ queryKey: ['receipt', receiptId] })
      }
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      if (purchaseOrderId) {
        void queryClient.invalidateQueries({ queryKey: ['purchase-order', purchaseOrderId] })
      }
    }

    const invalidatePurchaseOrders = (purchaseOrderId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      if (purchaseOrderId) {
        void queryClient.invalidateQueries({ queryKey: ['purchase-order', purchaseOrderId] })
      }
    }

    const handleEvent = (message: MessageEvent) => {
      if (!message.data) return
      let payload: ServerEvent | null = null
      try {
        payload = JSON.parse(message.data) as ServerEvent
      } catch {
        return
      }
      if (!payload) return

      const data = payload.data ?? {}
      const itemIds = uniq(asStringArray(data.itemIds ?? data.itemId))
      const locationIds = uniq(asStringArray(data.locationIds ?? data.locationId))
      const movementIds = uniq(
        asStringArray(data.movementIds ?? data.movementId).concat(
          asStringArray(data.issueMovementId),
          asStringArray(data.receiveMovementId),
        ),
      )

      switch (payload.type) {
        case 'inventory.adjustment.posted':
        case 'inventory.count.posted':
        case 'inventory.putaway.posted':
        case 'inventory.work_order.issue.posted':
        case 'inventory.work_order.completion.posted':
        case 'inventory.work_order.batch.posted':
        case 'inventory.reservation.created':
        case 'inventory.receipt.created':
        case 'inventory.receipt.deleted':
        case 'inventory.purchase_order.created':
        case 'inventory.purchase_order.updated':
        case 'inventory.purchase_order.deleted':
        case 'inventory.changed':
          invalidateInventory(itemIds, locationIds)
          break
        default:
          break
      }

      if (movementIds.length) {
        invalidateMovements(movementIds)
      }

      if (payload.type.startsWith('inventory.work_order.')) {
        const workOrderId =
          typeof data.workOrderId === 'string' ? data.workOrderId : undefined
        invalidateWorkOrders(workOrderId)
      }

      if (payload.type === 'inventory.reservation.created') {
        const reservationIds = asStringArray(data.reservationIds)
        invalidateReservations(reservationIds)
      }

      if (payload.type === 'inventory.receipt.created' || payload.type === 'inventory.receipt.deleted') {
        const receiptId = typeof data.receiptId === 'string' ? data.receiptId : undefined
        const purchaseOrderId =
          typeof data.purchaseOrderId === 'string' ? data.purchaseOrderId : undefined
        invalidateReceipts(receiptId, purchaseOrderId)
      }

      if (payload.type.startsWith('inventory.purchase_order.')) {
        const purchaseOrderId =
          typeof data.purchaseOrderId === 'string' ? data.purchaseOrderId : undefined
        invalidatePurchaseOrders(purchaseOrderId)
      }

      // Handle real-time dashboard metric updates
      if (payload.type === 'metrics:updated') {
        void queryClient.invalidateQueries({ queryKey: ['production-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['production-overview'] })
        void queryClient.invalidateQueries({ queryKey: ['abc-classification'] })
        void queryClient.invalidateQueries({ queryKey: ['inventory-aging'] })
        void queryClient.invalidateQueries({ queryKey: ['slow-dead-stock'] })
        void queryClient.invalidateQueries({ queryKey: ['turns-doi'] })
      }

      if (payload.type === 'production:changed' || payload.type === 'workorder:completed') {
        void queryClient.invalidateQueries({ queryKey: ['production-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['production-overview'] })
        const workOrderId =
          typeof data.workOrderId === 'string' ? data.workOrderId : undefined
        if (workOrderId) {
          void queryClient.invalidateQueries({ queryKey: ['work-order', workOrderId] })
          void queryClient.invalidateQueries({ queryKey: ['work-order-execution', workOrderId] })
        }
      }
    }

    EVENT_TYPES.forEach((type) => {
      source.addEventListener(type, handleEvent as EventListener)
    })
    source.addEventListener('message', handleEvent as EventListener)

    return () => {
      EVENT_TYPES.forEach((type) => {
        source.removeEventListener(type, handleEvent as EventListener)
      })
      source.removeEventListener('message', handleEvent as EventListener)
      source.close()
    }
  }, [accessToken, queryClient])
}
