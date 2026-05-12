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

  // Only classified quantities fill the bar; remaining is represented by the empty background.
  const barSegments = [
    { label: 'Accepted', value: metrics.accepted, pct: acceptedPct, color: 'bg-green-500' },
    { label: 'Hold', value: metrics.hold, pct: holdPct, color: 'bg-amber-500' },
    { label: 'Rejected', value: metrics.rejected, pct: rejectedPct, color: 'bg-red-500' },
  ].filter((s) => s.value > 0)

  // Legend includes remaining for counts, but remaining is not a bar segment.
  const legendItems = [
    { label: 'Accepted', value: metrics.accepted, color: 'bg-green-500' },
    { label: 'Hold', value: metrics.hold, color: 'bg-amber-500' },
    { label: 'Rejected', value: metrics.rejected, color: 'bg-red-500' },
    { label: 'Remaining', value: metrics.remaining, color: 'bg-slate-300' },
  ]

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
            {barSegments.map((segment, idx) => (
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
          {legendItems.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded ${item.color}`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-slate-700">{item.label}</div>
                <div className="text-sm font-semibold text-slate-900">
                  {formatNumber(item.value)}
                </div>
              </div>
            </div>
          ))}
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
