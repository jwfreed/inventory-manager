import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Alert } from '../../../components/Alert'
import { formatNumber } from '@shared/formatters'
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
    if (parts.length === 0) return 'Unknown item'
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

  const isDisassembly = summary.workOrder.kind === 'disassembly'

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card
        title={isDisassembly ? 'Consumed totals' : 'Issued totals'}
        description={isDisassembly ? 'Posted parent item consumption' : 'Posted component issues'}
      >
        {summary.issuedTotals.length === 0 ? (
          <div className="text-sm text-amber-700">
            No posted {isDisassembly ? 'consumption' : 'issues'} yet.
          </div>
        ) : (
          <ul className="space-y-2 text-sm text-slate-800">
            {summary.issuedTotals.map((row) => (
              <li key={`${row.componentItemId}-${row.uom}`} className="flex flex-col rounded-md border border-slate-200 px-3 py-2">
                <div className="text-slate-900 font-medium">
                  {renderLabel({ name: row.componentItemName, sku: row.componentItemSku, id: row.componentItemId })}
                </div>
                <div className="text-red-600">
                  -{formatNumber(row.quantityIssued)} {row.uom}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title={isDisassembly ? 'Produced totals' : 'Completed totals'}
        description={isDisassembly ? 'Posted disassembly outputs' : 'Posted completions'}
      >
        {summary.completedTotals.length === 0 ? (
          <div className="text-sm text-amber-700">
            No posted {isDisassembly ? 'outputs' : 'completions'} yet.
          </div>
        ) : (
          <ul className="space-y-2 text-sm text-slate-800">
            {summary.completedTotals.map((row) => (
              <li key={`${row.outputItemId}-${row.uom}`} className="flex flex-col rounded-md border border-slate-200 px-3 py-2">
                <div className="text-slate-900 font-medium">
                  {renderLabel({ name: row.outputItemName, sku: row.outputItemSku, id: row.outputItemId })}
                </div>
                <div className="text-green-700">
                  +{formatNumber(row.quantityCompleted)} {row.uom}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={isDisassembly ? 'Remaining to disassemble' : 'Remaining to complete'}>
        <div className="text-2xl font-semibold text-slate-900">
          {formatNumber(summary.remainingToComplete)} {summary.workOrder.outputUom}
        </div>
        <div className="mt-1 text-sm text-slate-600">
          {isDisassembly ? 'Based on posted issues.' : 'Based on posted completions.'}
        </div>
      </Card>
    </div>
  )
}
