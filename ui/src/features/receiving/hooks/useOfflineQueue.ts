import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  addOperation,
  getPendingOperations,
  updateOperation,
  removeOperation,
  getPendingCount,
  type OfflineOperation,
} from '../lib/indexedDB'

type UseOfflineQueueResult = {
  isOnline: boolean
  pendingCount: number
  pendingOperations: OfflineOperation[]
  isSyncing: boolean
  queueOperation: (operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'retries' | 'status'>) => Promise<string>
  syncPendingOperations: () => Promise<void>
  clearQueue: () => Promise<void>
}

type SyncHandler = (operation: OfflineOperation) => Promise<void>

/**
 * Hook for managing offline queue with IndexedDB persistence
 */
export function useOfflineQueue(syncHandler: SyncHandler): UseOfflineQueueResult {
  const queryClient = useQueryClient()
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [pendingOperations, setPendingOperations] = useState<OfflineOperation[]>([])
  const [isSyncing, setIsSyncing] = useState(false)

  // Update online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Load pending count on mount and when online status changes
  const loadPendingCount = useCallback(async () => {
    try {
      const count = await getPendingCount()
      setPendingCount(count)
    } catch (error) {
      console.error('Failed to load pending count:', error)
    }
  }, [])

  // Load pending operations
  const loadPendingOperations = useCallback(async () => {
    try {
      const operations = await getPendingOperations()
      setPendingOperations(operations)
      setPendingCount(operations.filter(op => op.status === 'pending').length)
    } catch (error) {
      console.error('Failed to load pending operations:', error)
    }
  }, [])

  useEffect(() => {
    loadPendingCount()
    loadPendingOperations()
  }, [loadPendingCount, loadPendingOperations])

  // Auto-sync when coming back online
  useEffect(() => {
    if (isOnline && pendingCount > 0 && !isSyncing) {
      syncPendingOperations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncPendingOperations is stable and intentionally excluded
  }, [isOnline, pendingCount, isSyncing])

  // Queue an operation
  const queueOperation = useCallback(async (
    operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'retries' | 'status'>
  ): Promise<string> => {
    try {
      const id = await addOperation(operation)
      await loadPendingCount()
      await loadPendingOperations()
      
      // If online, try to sync immediately
      if (isOnline) {
        syncPendingOperations()
      }
      
      return id
    } catch (error) {
      console.error('Failed to queue operation:', error)
      throw error
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncPendingOperations is stable and intentionally excluded
  }, [isOnline, loadPendingCount, loadPendingOperations])

  // Sync all pending operations
  const syncPendingOperations = useCallback(async () => {
    if (isSyncing) return

    setIsSyncing(true)

    try {
      const operations = await getPendingOperations()
      const pendingOps = operations.filter(op => op.status === 'pending')

      for (const operation of pendingOps) {
        try {
          // Mark as syncing
          await updateOperation(operation.id, { status: 'syncing' })

          // Execute sync handler
          await syncHandler(operation)

          // Remove from queue on success
          await removeOperation(operation.id)

          // Invalidate queries to refresh data
          queryClient.invalidateQueries()
        } catch (error) {
          console.error(`Failed to sync operation ${operation.id}:`, error)

          // Update with error status and increment retries
          await updateOperation(operation.id, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            retries: operation.retries + 1,
          })

          // Stop syncing on first error to preserve order
          break
        }
      }

      await loadPendingCount()
      await loadPendingOperations()
    } catch (error) {
      console.error('Failed to sync pending operations:', error)
    } finally {
      setIsSyncing(false)
    }
  }, [isSyncing, syncHandler, queryClient, loadPendingCount, loadPendingOperations])

  // Clear all queued operations (use with caution)
  const clearQueue = useCallback(async () => {
    try {
      const operations = await getPendingOperations()
      for (const op of operations) {
        await removeOperation(op.id)
      }
      await loadPendingCount()
      await loadPendingOperations()
    } catch (error) {
      console.error('Failed to clear queue:', error)
      throw error
    }
  }, [loadPendingCount, loadPendingOperations])

  return {
    isOnline,
    pendingCount,
    pendingOperations,
    isSyncing,
    queueOperation,
    syncPendingOperations,
    clearQueue,
  }
}
