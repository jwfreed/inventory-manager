import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useItem, useItemsList } from '../../items/queries'
import { useNextStepBoms } from '../../boms/queries'
import { createWorkOrder } from '../api/workOrders'
import type { ApiError } from '../../../api/types'
import { useWorkOrder, useWorkOrderExecution, useWorkOrderRequirements } from '../queries'
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
import { RecordBatchForm } from '../components/RecordBatchForm'
import { WorkOrderRequirementsTable } from '../components/WorkOrderRequirementsTable'
import { WorkOrderNextStepPanel } from '../components/WorkOrderNextStepPanel'

type TabKey = 'summary' | 'issues' | 'completions' | 'batch'

export default function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('summary')
  const [showNextStep, setShowNextStep] = useState(false)
  const [nextWorkOrderNumber, setNextWorkOrderNumber] = useState('')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [nextQuantity, setNextQuantity] = useState<number | ''>(1)
  const [createWarning, setCreateWarning] = useState<string | null>(null)

  const workOrderQuery = useWorkOrder(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const outputItemQuery = useItem(workOrderQuery.data?.outputItemId, { staleTime: 60_000 })

  const nextStepBomsQuery = useNextStepBoms(workOrderQuery.data?.outputItemId, {
    staleTime: 60_000,
  })

  const itemsLookupQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })

  const itemLabel = useCallback((id?: string) => {
    if (!id) return ''
    const found = itemsLookupQuery.data?.data?.find((itm) => itm.id === id)
    const name = found?.name
    const sku = found?.sku
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return id
  }, [itemsLookupQuery.data])

  const componentLabel = useCallback((id: string, name?: string | null, sku?: string | null) => {
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return itemLabel(id)
  }, [itemLabel])

  const nextBomOptions = useMemo(
    () =>
      (nextStepBomsQuery.data?.data ?? []).map((bom) => {
        const outputLabel = itemLabel(bom.outputItemId)
        const label = outputLabel ? `${bom.bomCode} → ${outputLabel}` : bom.bomCode
        return {
          value: bom.id,
          label,
          keywords: `${bom.bomCode} ${outputLabel}`.trim(),
        }
      }),
    [nextStepBomsQuery.data, itemLabel],
  )

  const createNextStep = async () => {
    if (!workOrderQuery.data) return
    const bom = nextStepBomsQuery.data?.data.find((b) => b.id === selectedBomId)
    if (!bom) {
      setCreateWarning('Select a BOM')
      return
    }
    if (!nextWorkOrderNumber) {
      setCreateWarning('Work order number required')
      return
    }
    const qty = nextQuantity === '' ? 0 : Number(nextQuantity)
    if (!(qty > 0)) {
      setCreateWarning('Quantity must be positive')
      return
    }
    setCreateWarning(null)
    const consumeLoc =
      workOrderQuery.data.defaultProduceLocationId ||
      outputItemQuery.data?.defaultLocationId ||
      null
    const produceLoc = outputItemQuery.data?.defaultLocationId ?? null
    const next = await createWorkOrder({
      workOrderNumber: nextWorkOrderNumber,
      bomId: bom.id,
      outputItemId: bom.outputItemId,
      outputUom: bom.defaultUom,
      quantityPlanned: qty,
      defaultConsumeLocationId: consumeLoc || undefined,
      defaultProduceLocationId: produceLoc || undefined,
    })
    setShowNextStep(false)
    setSelectedBomId('')
    setNextWorkOrderNumber('')
    setNextQuantity(1)
    navigate(`/work-orders/${next.id}`)
  }

  const executionQuery = useWorkOrderExecution(id)

  const requirementsQuery = useWorkOrderRequirements(id, undefined, { staleTime: 60_000 })

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
  const consumeLocationHint = workOrderQuery.data
    ? `Consume location defaults to ${
        workOrderQuery.data.defaultProduceLocationId || outputItemQuery.data?.defaultLocationId || '—'
      }.`
    : ''

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
      {workOrderQuery.data && (
        <WorkOrderHeader
          workOrder={workOrderQuery.data}
          outputItemLabel={itemLabel(workOrderQuery.data.outputItemId)}
        />
      )}

      <Section title="Execution summary">
        <ExecutionSummaryPanel
          summary={executionQuery.data}
          isLoading={executionQuery.isLoading}
          isError={executionQuery.isError}
          onRetry={() => void executionQuery.refetch()}
          errorMessage={executionQuery.error?.message}
        />
      </Section>

      <Section title="Requirements vs issued">
        {requirementsQuery.isLoading && <LoadingSpinner label="Loading requirements..." />}
        {requirementsQuery.isError && (
          <ErrorState
            error={requirementsQuery.error}
            onRetry={() => void requirementsQuery.refetch()}
          />
        )}
        {requirementsQuery.data && executionQuery.data && (
          <Card>
            <WorkOrderRequirementsTable
              lines={requirementsQuery.data.lines}
              issuedTotals={executionQuery.data.issuedTotals}
              componentLabel={componentLabel}
            />
            <div className="mt-3 text-xs text-slate-500">
              Material availability at consume locations is not shown here yet; check item inventory snapshots before issuing to avoid stalled WIP.
            </div>
          </Card>
        )}
      </Section>

      <Section title="Actions">
        <div className="flex gap-2 border-b border-slate-200">
          {(['summary', 'issues', 'completions', 'batch'] as TabKey[]).map((key) => (
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
                  : key === 'completions'
                    ? 'Completions'
                    : 'Record Batch'}
            </button>
          ))}
          <button
            className={`px-3 py-2 text-sm font-semibold ${
              showNextStep ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-600'
            }`}
            onClick={() => setShowNextStep((v) => !v)}
          >
            Create next step WO
          </button>
        </div>

        {workOrderQuery.data && (
          <WorkOrderNextStepPanel
            isOpen={showNextStep}
            nextWorkOrderNumber={nextWorkOrderNumber}
            selectedBomId={selectedBomId}
            nextQuantity={nextQuantity}
            nextBomOptions={nextBomOptions}
            isLoading={nextStepBomsQuery.isLoading}
            isError={nextStepBomsQuery.isError}
            error={nextStepBomsQuery.error as ApiError}
            createWarning={createWarning}
            consumeLocationHint={consumeLocationHint}
            onWorkOrderNumberChange={setNextWorkOrderNumber}
            onBomChange={setSelectedBomId}
            onQuantityChange={setNextQuantity}
            onCreate={createNextStep}
            onCancel={() => setShowNextStep(false)}
          />
        )}

        {tab === 'summary' && (
          <Card>
            <div className="text-sm text-slate-700">
              Posted issues create issue movements (negative). Posted completions create receive
              movements (positive). Remaining to complete:{' '}
              <span className="font-semibold">{remaining}</span>{' '}
              {workOrderQuery.data?.outputUom} of {itemLabel(workOrderQuery.data?.outputItemId)}
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
          <IssueDraftForm
            workOrder={workOrderQuery.data}
            outputItem={outputItemQuery.data}
            onRefetch={refreshAll}
          />
        )}

        {tab === 'completions' && workOrderQuery.data && (
          <CompletionDraftForm
            workOrder={workOrderQuery.data}
            outputItem={outputItemQuery.data}
            onRefetch={refreshAll}
          />
        )}

        {tab === 'batch' && workOrderQuery.data && (
          <RecordBatchForm
            workOrder={workOrderQuery.data}
            outputItem={outputItemQuery.data}
            onRefetch={refreshAll}
          />
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
