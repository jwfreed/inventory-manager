/**
 * IndexedDB utilities for offline queue persistence
 */

const DB_NAME = 'receiving-offline-queue'
const DB_VERSION = 1
const STORE_NAME = 'pending-operations'

export type OfflineOperation = {
  id: string
  type: 'qc-event' | 'putaway-create' | 'putaway-post' | 'receipt-create'
  payload: Record<string, unknown>
  timestamp: number
  retries: number
  status: 'pending' | 'syncing' | 'error'
  error?: string
}

let dbInstance: IDBDatabase | null = null

/**
 * Open IndexedDB connection
 */
export async function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      dbInstance = request.result
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('timestamp', 'timestamp', { unique: false })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('type', 'type', { unique: false })
      }
    }
  })
}

/**
 * Add operation to offline queue
 */
export async function addOperation(operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'retries' | 'status'>): Promise<string> {
  const db = await openDB()
  const id = `${operation.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  const fullOperation: OfflineOperation = {
    id,
    ...operation,
    timestamp: Date.now(),
    retries: 0,
    status: 'pending',
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.add(fullOperation)

    request.onsuccess = () => resolve(id)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get all pending operations
 */
export async function getPendingOperations(): Promise<OfflineOperation[]> {
  const db = await openDB()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      const operations = request.result as OfflineOperation[]
      // Sort by timestamp (oldest first)
      resolve(operations.sort((a, b) => a.timestamp - b.timestamp))
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Update operation status
 */
export async function updateOperation(id: string, updates: Partial<OfflineOperation>): Promise<void> {
  const db = await openDB()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const getRequest = store.get(id)

    getRequest.onsuccess = () => {
      const operation = getRequest.result as OfflineOperation
      if (!operation) {
        reject(new Error(`Operation ${id} not found`))
        return
      }

      const updated = { ...operation, ...updates }
      const putRequest = store.put(updated)

      putRequest.onsuccess = () => resolve()
      putRequest.onerror = () => reject(putRequest.error)
    }
    getRequest.onerror = () => reject(getRequest.error)
  })
}

/**
 * Remove operation from queue
 */
export async function removeOperation(id: string): Promise<void> {
  const db = await openDB()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * Clear all operations (use with caution)
 */
export async function clearAllOperations(): Promise<void> {
  const db = await openDB()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.clear()

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get count of pending operations
 */
export async function getPendingCount(): Promise<number> {
  const db = await openDB()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const index = store.index('status')
    const request = index.count('pending')

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
