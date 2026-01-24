import type { KpiDimension } from './registry'

export type TradeoffSlot = 'SERVICE' | 'COST' | 'RISK' | 'FLOW'

export type TradeoffPreferences = {
  version: 1
  selections: Partial<Record<TradeoffSlot, string>>
}

const STORAGE_KEY = 'dashboard-tradeoff-v1'

export function loadTradeoffPreferences(): TradeoffPreferences {
  if (typeof window === 'undefined') return { version: 1, selections: {} }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, selections: {} }
    const parsed = JSON.parse(raw) as TradeoffPreferences
    if (parsed?.version !== 1 || !parsed.selections) {
      return { version: 1, selections: {} }
    }
    return parsed
  } catch {
    return { version: 1, selections: {} }
  }
}

export function saveTradeoffPreferences(preferences: TradeoffPreferences) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function clearTradeoffPreferences() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}

export const TRADEOFF_DIMENSIONS: TradeoffSlot[] = ['SERVICE', 'COST', 'RISK', 'FLOW']

export function isTradeoffDimension(value: KpiDimension): value is TradeoffSlot {
  return TRADEOFF_DIMENSIONS.includes(value as TradeoffSlot)
}
