type WorkOrderDefaults = {
  consumeLocationId?: string
  produceLocationId?: string
}

const STORAGE_KEY = 'work-order-default-locations'

function loadAll(): Record<string, WorkOrderDefaults> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, WorkOrderDefaults>) : {}
  } catch {
    return {}
  }
}

function saveAll(all: Record<string, WorkOrderDefaults>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // ignore storage errors
  }
}

export function getWorkOrderDefaults(workOrderId: string): WorkOrderDefaults {
  const all = loadAll()
  return all[workOrderId] ?? {}
}

export function setWorkOrderDefaults(workOrderId: string, defaults: WorkOrderDefaults) {
  const all = loadAll()
  all[workOrderId] = { ...all[workOrderId], ...defaults }
  saveAll(all)
}
