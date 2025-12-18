import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Alert } from '../../../components/Alert'
import { formatNumber } from '../../../lib/formatters'
import type { WorkOrderExecutionSummary } from '../../../api/types'

type Props = {
  summary?: WorkOrderExecutionSummary
  isLoading: boolean
  isError: boolean
  onRetry?: () => void
  errorMessage?: string
}

export function ExecutionSummaryPanel({ summary, isLoading, isError, onRetry, errorMessage }: Props) {
  const renderLabel = (opts: { name?: string | null; sku?: string | null; id: string }) => {
    const parts = []
    if (opts.name) parts.push(opts.name)
    if (opts.sku) parts.push(opts.sku)
    if (parts.length === 0) parts.push(opts.id)
    else parts.push(`(${opts.id})`)
    return parts.join(' — ')
  }

  if (isLoading) return <LoadingSpinner label="Loading execution summary..." />
  if (isError)
    return (
      <Alert
        variant="error"
        title="Execution summary unavailable"
        message={errorMessage || 'Failed to load execution summary.'}
        action={
          onRetry && (
            <button
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
              onClick={onRetry}
            >
              Retry
            </button>
          )
        }
      />
    )
  if (!summary)
    return (
      <EmptyState
        title="Execution summary not available"
        description="No posted issues or completions yet."
      />
    )

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Issued totals" description="Posted component issues">
        {summary.issuedTotals.length === 0 ? (
          <div className="text-sm text-slate-600">No posted issues yet.</div>
        ) : (
          <ul className="space-y-2 text-sm text-slate-800">
            {summary.issuedTotals.map((row) => (
              <li key={`${row.componentItemId}-${row.uom}`} className="flex justify-between">
                <span>{renderLabel({ name: row.componentItemName, sku: row.componentItemSku, id: row.componentItemId })}</span>
                <span className="text-red-600">
                  -{formatNumber(row.quantityIssued)} {row.uom}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Completed totals" description="Posted completions">
        {summary.completedTotals.length === 0 ? (
          <div className="text-sm text-slate-600">No posted completions yet.</div>
        ) : (
          <ul className="space-y-2 text-sm text-slate-800">
            {summary.completedTotals.map((row) => (
              <li key={`${row.outputItemId}-${row.uom}`} className="flex justify-between">
                <span>{renderLabel({ name: row.outputItemName, sku: row.outputItemSku, id: row.outputItemId })}</span>
                <span className="text-green-700">
                  +{formatNumber(row.quantityCompleted)} {row.uom}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Remaining to complete">
        <div className="text-2xl font-semibold text-slate-900">
          {formatNumber(summary.remainingToComplete)} {summary.workOrder.outputUom}
        </div>
        <div className="mt-1 text-sm text-slate-600">Based on posted completions.</div>
      </Card>
    </div>
  )
}
