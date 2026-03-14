import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError, WorkOrder } from '@api/types'
import { useItemsList } from '@features/items/queries'
import { cancelWorkOrder, markWorkOrderReady } from '../api/workOrders'
import { useWorkOrdersList, workOrdersQueryKeys } from '../queries'
import { Alert, Button, EmptyState, LoadingSpinner, PageHeader, Panel } from '@shared/ui'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { WorkOrdersFilters } from '../components/WorkOrdersFilters'
import { WorkOrdersTable } from '../components/WorkOrdersTable'
import { WorkOrderCancelModal } from '../components/WorkOrderCancelModal'
import { getWorkOrderActionPolicy } from '../lib/workOrderActionPolicy'
import { useWorkOrdersListData } from '../hooks/useWorkOrdersListData'
import { usePageChrome } from '../../../app/layout/usePageChrome'

function formatError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export default function WorkOrdersListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { hideTitle } = usePageChrome()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState(() => searchParams.get('status') || '')
  const [search, setSearch] = useState('')
  const [plannedDate, setPlannedDate] = useState('')
  const [kind, setKind] = useState('')
  const [selectedCancelOrder, setSelectedCancelOrder] = useState<WorkOrder | null>(null)
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)

  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })

  const plannedFrom = plannedDate ? `${plannedDate}T00:00:00` : undefined
  const plannedTo = plannedDate ? `${plannedDate}T23:59:59.999` : undefined

  const { data, isLoading, isError, error, refetch, isFetching } = useWorkOrdersList({
    status: status || undefined,
    kind: kind || undefined,
    plannedFrom,
    plannedTo,
    limit: 50,
  })

  const { filtered, remaining, formatOutput } = useWorkOrdersListData(
    data?.data ?? [],
    itemsQuery.data?.data ?? [],
    search,
  )

  const invalidateWorkOrders = async () => {
    await queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.all })
  }

  const markReadyMutation = useMutation({
    mutationFn: async (workOrder: WorkOrder) => {
      setPendingActionId(workOrder.id)
      return markWorkOrderReady(workOrder.id)
    },
    onSuccess: async (updated) => {
      setLifecycleError(null)
      setLifecycleMessage(`${updated.number} is ready for production.`)
      await invalidateWorkOrders()
    },
    onError: (err) => {
      setLifecycleMessage(null)
      setLifecycleError(formatError(err, 'Failed to mark work order ready.'))
    },
    onSettled: () => {
      setPendingActionId(null)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: async (workOrder: WorkOrder) => {
      setPendingActionId(workOrder.id)
      return cancelWorkOrder(workOrder.id)
    },
    onSuccess: async (updated) => {
      setLifecycleError(null)
      setLifecycleMessage(`${updated.number} was canceled.`)
      setSelectedCancelOrder(null)
      await invalidateWorkOrders()
    },
    onError: (err) => {
      setLifecycleMessage(null)
      setLifecycleError(formatError(err, 'Failed to cancel work order.'))
    },
    onSettled: () => {
      setPendingActionId(null)
    },
  })

  return (
    <div className="space-y-6">
      {!hideTitle && (
        <PageHeader
          title="Work Orders"
          subtitle="Drafts do not affect inventory. Posting issues and completions creates ledger movements."
          action={
            <Button size="sm" onClick={() => navigate('/work-orders/new')}>
              New work order
            </Button>
          }
        />
      )}
      {hideTitle && (
        <div>
          <Button size="sm" onClick={() => navigate('/work-orders/new')}>
            New work order
          </Button>
        </div>
      )}

      <WorkOrdersFilters
        status={status}
        search={search}
        plannedDate={plannedDate}
        kind={kind}
        isFetching={isFetching}
        onStatusChange={setStatus}
        onSearchChange={setSearch}
        onPlannedDateChange={setPlannedDate}
        onKindChange={setKind}
        onRefresh={() => void refetch()}
        onReset={() => {
          setStatus('')
          setSearch('')
          setPlannedDate('')
          setKind('')
        }}
      />

      <Panel title="Execution queue" description="Prioritize active orders and resolve stalled production before due dates slip.">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <div>
            Showing {filtered.length} work orders
            {(status || search || plannedDate || kind) ? ' (filtered)' : ''}
          </div>
          {isFetching && <span className="text-xs uppercase tracking-wide text-slate-400">Updating…</span>}
        </div>
        {lifecycleMessage ? (
          <Alert variant="success" title="Work order updated" message={lifecycleMessage} />
        ) : null}
        {lifecycleError ? (
          <Alert variant="error" title="Lifecycle update failed" message={lifecycleError} />
        ) : null}
        {isLoading && <LoadingSpinner label="Loading work orders..." />}
        {isError && error && (
          <Alert
            variant="error"
            title="Failed to load work orders"
            message={error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <EmptyState
            title="No work orders found"
            description="Adjust filters or create a new work order."
          />
        )}
        {!isLoading && !isError && filtered.length > 0 && (
          <WorkOrdersTable
            rows={filtered}
            onSelect={(row) => navigate(`/work-orders/${row.id}`)}
            formatOutput={formatOutput}
            remaining={remaining}
            renderActions={(row) => {
              const policy = getWorkOrderActionPolicy(row)
              const rowPending = pendingActionId === row.id
              return (
                <>
                  {policy.canQuickMarkReady ? (
                    <Button
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation()
                        setLifecycleMessage(null)
                        setLifecycleError(null)
                        markReadyMutation.mutate(row)
                      }}
                      disabled={rowPending}
                    >
                      {markReadyMutation.isPending && rowPending ? 'Marking...' : 'Mark ready'}
                    </Button>
                  ) : null}
                  {policy.canQuickCancel ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        setLifecycleMessage(null)
                        setLifecycleError(null)
                        setSelectedCancelOrder(row)
                      }}
                      disabled={rowPending}
                    >
                      {cancelMutation.isPending && rowPending ? 'Canceling...' : 'Cancel'}
                    </Button>
                  ) : null}
                </>
              )
            }}
          />
        )}
      </Panel>
      <WorkOrderCancelModal
        isOpen={Boolean(selectedCancelOrder)}
        workOrder={selectedCancelOrder}
        isPending={cancelMutation.isPending}
        errorMessage={selectedCancelOrder ? lifecycleError : null}
        onCancel={() => {
          setSelectedCancelOrder(null)
          setLifecycleError(null)
        }}
        onConfirm={() => {
          if (!selectedCancelOrder) return
          cancelMutation.mutate(selectedCancelOrder)
        }}
      />
    </div>
  )
}
