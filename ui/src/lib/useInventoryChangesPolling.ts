import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { InventoryChangeScope } from '../api/types'
import { getInventoryChanges } from '../features/inventory/api/inventoryChanges'
import { inventoryQueryKeys } from '../features/inventory/queries'
import { itemsQueryKeys } from '../features/items/queries'
import { locationsQueryKeys } from '../features/locations/queries'

const DEFAULT_POLL_INTERVAL_MS = Number(
  import.meta.env.VITE_INVENTORY_CHANGES_POLL_INTERVAL_MS ?? 15000,
)
const DEFAULT_LIMIT = Number(import.meta.env.VITE_INVENTORY_CHANGES_LIMIT ?? 200)
const ENABLE_POLLING = import.meta.env.VITE_INVENTORY_CHANGES_POLLING === 'true'

function uniq(values: string[]) {
  return Array.from(new Set(values))
}

function uniqScopes(scopes: InventoryChangeScope[]) {
  const seen = new Set<string>()
  return scopes.filter((scope) => {
    const key = `${scope.itemId ?? ''}:${scope.locationId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function matchesScope(
  params: { itemId?: string; locationId?: string } | undefined,
  scope: InventoryChangeScope,
) {
  if (!params) return true
  if (params.itemId && (!scope.itemId || params.itemId !== scope.itemId)) return false
  if (params.locationId && (!scope.locationId || params.locationId !== scope.locationId)) return false
  return true
}

function invalidateInventoryScopes(queryClient: ReturnType<typeof useQueryClient>, scopes: InventoryChangeScope[]) {
  if (scopes.length === 0) return

  const itemIds = uniq(scopes.map((scope) => scope.itemId).filter(Boolean) as string[])
  const locationIds = uniq(scopes.map((scope) => scope.locationId).filter(Boolean) as string[])

  itemIds.forEach((itemId) => {
    void queryClient.invalidateQueries({ queryKey: itemsQueryKeys.inventorySummary(itemId) })
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'atp' && query.queryKey[1] === itemId })
  })

  locationIds.forEach((locationId) => {
    void queryClient.invalidateQueries({ queryKey: locationsQueryKeys.inventorySummary(locationId) })
  })

  void queryClient.invalidateQueries({
    predicate: (query) => {
      const [key, subkey, params] = query.queryKey as [string, string, Record<string, unknown> | undefined]
      if (key === inventoryQueryKeys.all[0] && subkey === 'snapshot-summary') {
        return scopes.some((scope) => matchesScope(params as { itemId?: string; locationId?: string }, scope))
      }
      return false
    },
  })

  void queryClient.invalidateQueries({
    predicate: (query) => {
      const [key, subkey, params] = query.queryKey as [string, string, Record<string, unknown> | undefined]
      if (key === 'movements' && subkey === 'window') {
        return scopes.some((scope) => matchesScope(params as { itemId?: string; locationId?: string }, scope))
      }
      return false
    },
  })
}

function invalidateInventoryBroad(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0] as string | undefined
      return key === inventoryQueryKeys.all[0] ||
        key === itemsQueryKeys.all[0] ||
        key === locationsQueryKeys.all[0] ||
        key === 'movements' ||
        key === 'atp'
    },
  })
}

function getStorageKey(tenantId?: string | null) {
  return tenantId ? `inventory_changes_seq:${tenantId}` : 'inventory_changes_seq'
}

function readStoredSeq(storageKey: string) {
  if (typeof window === 'undefined') return '0'
  try {
    const value = window.localStorage.getItem(storageKey)
    return value && /^\d+$/.test(value) ? value : '0'
  } catch {
    return '0'
  }
}

function writeStoredSeq(storageKey: string, seq: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey, seq)
  } catch {
    // ignore storage failures
  }
}

export function useInventoryChangesPolling(
  enabled: boolean,
  tenantId?: string | null,
  options?: { pollIntervalMs?: number; limit?: number },
) {
  const queryClient = useQueryClient()
  const pollIntervalMs = Number.isFinite(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    ? (options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    : 15000
  const limit = Number.isFinite(options?.limit ?? DEFAULT_LIMIT)
    ? (options?.limit ?? DEFAULT_LIMIT)
    : 200

  const storageKey = useMemo(() => getStorageKey(tenantId), [tenantId])
  const lastSeqRef = useRef<string>('0')
  const timeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !ENABLE_POLLING) return

    lastSeqRef.current = readStoredSeq(storageKey)
    let cancelled = false

    const scheduleNext = () => {
      if (cancelled) return
      timeoutRef.current = window.setTimeout(() => void poll(), pollIntervalMs)
    }

    const poll = async () => {
      if (cancelled) return
      try {
        const response = await getInventoryChanges({ since: lastSeqRef.current, limit })
        const scopes = uniqScopes(response.events.map((event) => event.scope).filter(Boolean))

        if (response.resetRequired) {
          invalidateInventoryBroad(queryClient)
        }

        if (scopes.length > 0) {
          invalidateInventoryScopes(queryClient, scopes)
        }

        if (response.nextSeq && response.nextSeq !== lastSeqRef.current) {
          lastSeqRef.current = response.nextSeq
          writeStoredSeq(storageKey, response.nextSeq)
        }
      } catch (error) {
        const err = error as { status?: number }
        if (err?.status === 401) {
          return
        }
      } finally {
        scheduleNext()
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [enabled, limit, pollIntervalMs, queryClient, storageKey])
}
