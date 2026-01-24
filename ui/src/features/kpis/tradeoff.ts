import type { KpiSnapshot } from '@api/types'
import { KPI_REGISTRY, type KpiDimension, type KpiDefinition } from './registry'
import type { TradeoffSlot } from './tradeoffPreferences'

export function buildLatestSnapshotMap(snapshots: KpiSnapshot[]) {
  const latest = new Map<string, KpiSnapshot>()
  snapshots.forEach((snapshot) => {
    const key = snapshot.kpi_name
    const current = latest.get(key)
    const currentTime = current ? new Date(current.computed_at || 0).getTime() : -Infinity
    const nextTime = new Date(snapshot.computed_at || 0).getTime()
    if (!current || nextTime > currentTime) {
      latest.set(key, snapshot)
    }
  })
  return latest
}

export function listKpisByDimension(dimension: KpiDimension) {
  return KPI_REGISTRY.filter((kpi) => kpi.dimension === dimension)
}

export function buildKpiCatalog(snapshots: KpiSnapshot[]) {
  const catalog = new Map<string, KpiDefinition>()
  KPI_REGISTRY.forEach((kpi) => catalog.set(kpi.name, kpi))
  snapshots.forEach((snapshot) => {
    if (catalog.has(snapshot.kpi_name)) return
    catalog.set(snapshot.kpi_name, {
      name: snapshot.kpi_name,
      displayName: snapshot.kpi_name,
      description: 'No registry metadata available.',
      dimension: 'OTHER',
    })
  })
  return Array.from(catalog.values())
}

export function resolveDefaultKpi(
  dimension: TradeoffSlot,
  availableKpis: Set<string>,
) {
  const candidates = listKpisByDimension(dimension)
  return candidates.find((kpi) => availableKpis.has(kpi.name))?.name ?? null
}

export function resolveKpiDefinition(name: string | null): KpiDefinition | null {
  if (!name) return null
  return KPI_REGISTRY.find((kpi) => kpi.name === name) ?? null
}

export function resolveMissingDimensions(selectedKpis: KpiDefinition[]) {
  const present = new Set(selectedKpis.map((kpi) => kpi.dimension))
  return (['SERVICE', 'COST', 'RISK'] as TradeoffSlot[]).filter((dimension) => !present.has(dimension))
}
