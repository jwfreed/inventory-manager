import type { KpiSnapshot } from '../../../api/types'
import { formatNumber } from '../../../lib/formatters'
import { formatDateTime } from '../utils'

type Props = {
  snapshots: KpiSnapshot[]
}

function pickLatestPerKpi(snapshots: KpiSnapshot[]) {
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

  return Array.from(latest.values())
    .sort((a, b) => a.kpi_name.localeCompare(b.kpi_name))
    .slice(0, 6)
}

export function KpiCardGrid({ snapshots }: Props) {
  const cards = pickLatestPerKpi(snapshots)

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((snapshot) => {
        const value =
          typeof snapshot.value === 'number'
            ? formatNumber(snapshot.value)
            : snapshot.value ?? '—'
        return (
          <div
            key={`${snapshot.kpi_name}-${snapshot.computed_at}`}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              {snapshot.kpi_name}
            </p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-semibold text-slate-900">{value}</span>
              {snapshot.unit && (
                <span className="text-sm font-medium text-slate-500">{snapshot.unit}</span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              As of {formatDateTime(snapshot.computed_at) || 'unknown'}
            </p>
          </div>
        )
      })}
    </div>
  )
}
