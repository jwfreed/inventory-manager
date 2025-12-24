import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  getWorkOrder,
  getWorkOrderExecution,
  getWorkOrderRequirements,
} from '../../../api/endpoints/workOrders'
import { getItem, listItems } from '../../../api/endpoints/items'
import { listNextStepBoms } from '../../../api/endpoints/boms'
import { createWorkOrder } from '../../../api/endpoints/workOrders'
import type { ApiError, WorkOrderRequirements } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Combobox } from '../../../components/Combobox'
import { EmptyState } from '../../../components/EmptyState'
import { ErrorState } from '../../../components/ErrorState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { WorkOrderHeader } from '../components/WorkOrderHeader'
import { ExecutionSummaryPanel } from '../components/ExecutionSummaryPanel'
import { IssueDraftForm } from '../components/IssueDraftForm'
import { CompletionDraftForm } from '../components/CompletionDraftForm'
import { RecordBatchForm } from '../components/RecordBatchForm'

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

  const workOrderQuery = useQuery({
    queryKey: ['work-order', id],
    queryFn: () => getWorkOrder(id as string),
    enabled: !!id,
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const outputItemQuery = useQuery({
    queryKey: ['item', 'wo-output', workOrderQuery.data?.outputItemId],
    queryFn: () => getItem(workOrderQuery.data?.outputItemId as string),
    enabled: Boolean(workOrderQuery.data?.outputItemId),
    staleTime: 60_000,
  })

  const nextStepBomsQuery = useQuery({
    queryKey: ['next-step-boms', workOrderQuery.data?.outputItemId],
    queryFn: () => listNextStepBoms(workOrderQuery.data?.outputItemId as string),
    enabled: Boolean(workOrderQuery.data?.outputItemId),
    staleTime: 60_000,
  })

  const itemsLookupQuery = useQuery({
    queryKey: ['items', 'wo-detail'],
    queryFn: () => listItems({ limit: 500 }),
    staleTime: 60_000,
  })

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

  const executionQuery = useQuery({
    queryKey: ['work-order-execution', id],
    queryFn: () => getWorkOrderExecution(id as string),
    enabled: !!id,
    retry: 1,
  })

  const requirementsQuery = useQuery<WorkOrderRequirements, ApiError>({
    queryKey: ['work-order-requirements', id],
    queryFn: () => getWorkOrderRequirements(id as string),
    enabled: !!id,
    staleTime: 60_000,
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
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-2">Line</th>
                    <th className="px-2 py-2">Component</th>
                    <th className="px-2 py-2">Required</th>
                    <th className="px-2 py-2">Issued</th>
                    <th className="px-2 py-2">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {requirementsQuery.data.lines.map((line) => {
                    const issued = executionQuery.data?.issuedTotals.find(
                      (i) => i.componentItemId === line.componentItemId && i.uom === line.uom,
                    )
                    const qtyIssued = issued?.quantityIssued ?? 0
                    const remaining = Math.max(0, line.quantityRequired - qtyIssued)
                    return (
                      <tr key={line.lineNumber} className="border-b border-slate-100">
                        <td className="px-2 py-2 font-mono text-xs text-slate-600">
                          {line.lineNumber}
                        </td>
                        <td className="px-2 py-2">
                          {componentLabel(line.componentItemId, line.componentItemName, line.componentItemSku)}
                        </td>
                        <td className="px-2 py-2">
                          {line.quantityRequired} {line.uom}
                        </td>
                        <td className="px-2 py-2 text-red-600">
                          {qtyIssued ? `-${qtyIssued}` : '0'} {line.uom}
                        </td>
                        <td className="px-2 py-2 font-semibold text-slate-800">
                          {remaining} {line.uom}
                        </td>
                      </tr>
                    )
                  })}
                  </tbody>
                </table>
              </div>
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

        {showNextStep && workOrderQuery.data && (
          <Card>
            <div className="space-y-3">
              <div className="text-sm text-slate-700">
                Suggests BOMs where this WO output is a component. Defaults consume location to this WO&apos;s
                production location and falls back to the item default location.
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Work order number</span>
                  <input
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={nextWorkOrderNumber}
                    onChange={(e) => setNextWorkOrderNumber(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm md:col-span-2">
                  <Combobox
                    label="Next BOM"
                    value={selectedBomId}
                    options={nextBomOptions}
                    loading={nextStepBomsQuery.isLoading}
                    disabled={nextStepBomsQuery.isLoading}
                    placeholder="Search suggested BOMs"
                    emptyMessage="No suggested BOMs"
                    onChange={(nextValue) => setSelectedBomId(nextValue)}
                  />
                  {nextStepBomsQuery.isError && (
                    <p className="text-xs text-red-600">
                      {(nextStepBomsQuery.error as ApiError)?.message ?? 'Failed to load suggestions.'}
                    </p>
                  )}
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Quantity planned</span>
                  <input
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    type="number"
                    min={0}
                    value={nextQuantity}
                    onChange={(e) => setNextQuantity(e.target.value === '' ? '' : Number(e.target.value))}
                  />
                </label>
                <div className="text-sm text-slate-600 md:col-span-2">
                  Consume location defaults to {workOrderQuery.data.defaultProduceLocationId || outputItemQuery.data?.defaultLocationId || '—'}.
                </div>
              </div>
              {createWarning && <div className="text-sm text-red-600">{createWarning}</div>}
              <div className="flex gap-2">
                <Button size="sm" onClick={createNextStep} disabled={nextStepBomsQuery.isLoading}>
                  Create next-step WO
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setShowNextStep(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
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
