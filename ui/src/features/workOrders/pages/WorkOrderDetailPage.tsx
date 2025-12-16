import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  getWorkOrder,
  getWorkOrderExecution,
} from '../../../api/endpoints/workOrders'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { WorkOrderHeader } from '../components/WorkOrderHeader'
import { ExecutionSummaryPanel } from '../components/ExecutionSummaryPanel'
import { IssueDraftForm } from '../components/IssueDraftForm'
import { CompletionDraftForm } from '../components/CompletionDraftForm'

type TabKey = 'summary' | 'issues' | 'completions'

export default function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('summary')

  const workOrderQuery = useQuery({
    queryKey: ['work-order', id],
    queryFn: () => getWorkOrder(id as string),
    enabled: !!id,
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const executionQuery = useQuery({
    queryKey: ['work-order-execution', id],
    queryFn: () => getWorkOrderExecution(id as string),
    enabled: !!id,
    retry: 1,
  })

  const refreshAll = () => {
    void workOrderQuery.refetch()
    void executionQuery.refetch()
  }

  const remaining = useMemo(() => {
    if (!workOrderQuery.data) return 0
    return Math.max(
      0,
      (workOrderQuery.data.quantityPlanned || 0) - (workOrderQuery.data.quantityCompleted ?? 0),
    )
  }, [workOrderQuery.data])

  if (workOrderQuery.isError && workOrderQuery.error?.status === 404) {
    return <ErrorState error={workOrderQuery.error} />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Execution</p>
          <h2 className="text-2xl font-semibold text-slate-900">Work Order Detail</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/work-orders')}>
          Back to list
        </Button>
      </div>

      {workOrderQuery.isLoading && <LoadingSpinner label="Loading work order..." />}
      {workOrderQuery.isError && workOrderQuery.error && (
        <ErrorState error={workOrderQuery.error} onRetry={() => void workOrderQuery.refetch()} />
      )}
      {workOrderQuery.data && <WorkOrderHeader workOrder={workOrderQuery.data} />}

      <Section title="Execution summary">
        <ExecutionSummaryPanel
          summary={executionQuery.data}
          isLoading={executionQuery.isLoading}
          isError={executionQuery.isError}
          onRetry={() => void executionQuery.refetch()}
          errorMessage={executionQuery.error?.message}
        />
      </Section>

      <Section title="Actions">
        <div className="flex gap-2 border-b border-slate-200">
          {(['summary', 'issues', 'completions'] as TabKey[]).map((key) => (
            <button
              key={key}
              className={`px-3 py-2 text-sm font-semibold ${
                tab === key ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-600'
              }`}
              onClick={() => setTab(key)}
            >
              {key === 'summary'
                ? 'Execution Summary'
                : key === 'issues'
                  ? 'Issues'
                  : 'Completions'}
            </button>
          ))}
        </div>

        {tab === 'summary' && (
          <Card>
            <div className="text-sm text-slate-700">
              Posted issues create issue movements (negative). Posted completions create receive
              movements (positive). Remaining to complete:{' '}
              <span className="font-semibold">{remaining}</span>{' '}
              {workOrderQuery.data?.outputUom}
            </div>
            {!executionQuery.data && !executionQuery.isLoading && (
              <EmptyState
                title="No execution yet"
                description="Create an issue or completion to begin execution."
              />
            )}
          </Card>
        )}

        {tab === 'issues' && workOrderQuery.data && (
          <IssueDraftForm workOrder={workOrderQuery.data} onRefetch={refreshAll} />
        )}

        {tab === 'completions' && workOrderQuery.data && (
          <CompletionDraftForm workOrder={workOrderQuery.data} onRefetch={refreshAll} />
        )}
      </Section>

      {executionQuery.data?.workOrder.completedAt && (
        <Alert
          variant="info"
          title="Completed"
          message={`Work order marked completed at ${executionQuery.data.workOrder.completedAt}`}
        />
      )}
    </div>
  )
}
