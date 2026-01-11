import { Card } from '@shared/ui'
import { formatNumber } from '@shared/formatters'

type QcMetrics = {
  totalQuantity: number
  accepted: number
  hold: number
  rejected: number
  remaining: number
}

type Props = {
  metrics: QcMetrics
  className?: string
}

export function QcMetricsChart({ metrics, className }: Props) {
  const total = metrics.totalQuantity
  const acceptedPct = total > 0 ? (metrics.accepted / total) * 100 : 0
  const holdPct = total > 0 ? (metrics.hold / total) * 100 : 0
  const rejectedPct = total > 0 ? (metrics.rejected / total) * 100 : 0
  const remainingPct = total > 0 ? (metrics.remaining / total) * 100 : 0

  const segments = [
    { label: 'Accepted', value: metrics.accepted, pct: acceptedPct, color: 'bg-green-500' },
    { label: 'Hold', value: metrics.hold, pct: holdPct, color: 'bg-amber-500' },
    { label: 'Rejected', value: metrics.rejected, pct: rejectedPct, color: 'bg-red-500' },
    { label: 'Remaining', value: metrics.remaining, pct: remainingPct, color: 'bg-slate-300' },
  ].filter((s) => s.value > 0)

  const completionRate = total > 0 ? ((total - metrics.remaining) / total) * 100 : 0

  return (
    <Card className={className}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">
            QC Progress
          </h3>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-900">
              {Math.round(completionRate)}%
            </div>
            <div className="text-xs text-slate-500">Complete</div>
          </div>
        </div>

        {/* Stacked Bar Chart */}
        <div>
          <div className="h-8 w-full bg-slate-100 rounded-lg overflow-hidden flex">
            {segments.map((segment, idx) => (
              <div
                key={idx}
                className={`${segment.color} transition-all duration-300 relative group`}
                style={{ width: `${segment.pct}%` }}
                title={`${segment.label}: ${formatNumber(segment.value)} (${Math.round(segment.pct)}%)`}
              >
                {segment.pct > 8 && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white">
                    {Math.round(segment.pct)}%
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-green-500" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700">Accepted</div>
              <div className="text-sm font-semibold text-slate-900">
                {formatNumber(metrics.accepted)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-amber-500" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700">Hold</div>
              <div className="text-sm font-semibold text-slate-900">
                {formatNumber(metrics.hold)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-red-500" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700">Rejected</div>
              <div className="text-sm font-semibold text-slate-900">
                {formatNumber(metrics.rejected)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-slate-300" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700">Remaining</div>
              <div className="text-sm font-semibold text-slate-900">
                {formatNumber(metrics.remaining)}
              </div>
            </div>
          </div>
        </div>

        {/* Total */}
        <div className="pt-3 border-t border-slate-200">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-700">Total Received</span>
            <span className="text-lg font-bold text-slate-900">{formatNumber(total)}</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
