import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useItem, useItemsList } from '@features/items/queries'
import { useBom, useBomsByItem, useNextStepBoms } from '@features/boms/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createWorkOrder, updateWorkOrderDescription, useActiveBomVersion } from '../api/workOrders'
import type { ApiError } from '@api/types'
import { useWorkOrder, useWorkOrderExecution, useWorkOrderRequirements, workOrdersQueryKeys } from '../queries'
import { Alert, Button, Card, EmptyState, ErrorState, LoadingSpinner, Modal, Section, Textarea } from '@shared/ui'
import { WorkOrderHeader } from '../components/WorkOrderHeader'
import { ExecutionSummaryPanel } from '../components/ExecutionSummaryPanel'
import { IssueDraftForm } from '../components/IssueDraftForm'
import { CompletionDraftForm } from '../components/CompletionDraftForm'
import { RecordBatchForm } from '../components/RecordBatchForm'
import { WorkOrderRequirementsTable } from '../components/WorkOrderRequirementsTable'
import { WorkOrderNextStepPanel } from '../components/WorkOrderNextStepPanel'
import { useLocationsList } from '@features/locations/queries'
import { getAtp } from '@api/reports'
import type { AtpResult } from '@api/types'
import { formatNumber } from '@shared/formatters'

type TabKey = 'summary' | 'issues' | 'completions' | 'batch'

export default function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<TabKey>('summary')
  const [pendingScroll, setPendingScroll] = useState(false)
  const [highlightIssues, setHighlightIssues] = useState(false)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const issuesHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const [showNextStep, setShowNextStep] = useState(false)
  const [selectedBomId, setSelectedBomId] = useState('')
  const [nextQuantity, setNextQuantity] = useState<number | ''>(1)
  const [createWarning, setCreateWarning] = useState<string | null>(null)
  const [showBomSwitchConfirm, setShowBomSwitchConfirm] = useState(false)
  const [bomSwitchError, setBomSwitchError] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [summaryFlash, setSummaryFlash] = useState(false)

  const queryClient = useQueryClient()

  const workOrderQuery = useWorkOrder(id, {
    retry: (count, err: ApiError) => err?.status !== 404 && count < 1,
  })

  const outputItemQuery = useItem(workOrderQuery.data?.outputItemId, { staleTime: 60_000 })
  const bomQuery = useBom(workOrderQuery.data?.bomId, {
    staleTime: 60_000,
    enabled: Boolean(workOrderQuery.data?.bomId),
  })
  const bomsByItemQuery = useBomsByItem(workOrderQuery.data?.outputItemId, {
    staleTime: 60_000,
    enabled: Boolean(workOrderQuery.data?.outputItemId),
  })

  const nextStepBomsQuery = useNextStepBoms(workOrderQuery.data?.outputItemId, {
    staleTime: 60_000,
  })

  const itemsLookupQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ limit: 500, active: true }, { staleTime: 60_000 })

  const itemLabel = useCallback((id?: string) => {
    if (!id) return ''
    const found = itemsLookupQuery.data?.data?.find((itm) => itm.id === id)
    const name = found?.name
    const sku = found?.sku
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return 'Unknown item'
  }, [itemsLookupQuery.data])

  const componentLabel = useCallback((id: string, name?: string | null, sku?: string | null) => {
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return itemLabel(id) || 'Unknown item'
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

  const actionParamToTab = useCallback((value: string | null): TabKey | null => {
    switch (value) {
      case 'use-materials':
        return 'issues'
      case 'make-product':
        return 'completions'
      case 'issue-complete':
        return 'batch'
      case 'overview':
        return 'summary'
      default:
        return null
    }
  }, [])

  const tabToActionParam = useCallback((value: TabKey): string => {
    switch (value) {
      case 'issues':
        return 'use-materials'
      case 'completions':
        return 'make-product'
      case 'batch':
        return 'issue-complete'
      default:
        return 'overview'
    }
  }, [])

  const updateTab = useCallback(
    (nextTab: TabKey) => {
      setTab(nextTab)
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('action', tabToActionParam(nextTab))
      setSearchParams(nextParams, { replace: false })
    },
    [searchParams, setSearchParams, tabToActionParam],
  )

  const goToIssues = useCallback(() => {
    updateTab('issues')
    setPendingScroll(true)
  }, [updateTab])

  useEffect(() => {
    const tabFromQuery = actionParamToTab(searchParams.get('action'))
    if (tabFromQuery && tabFromQuery !== tab) {
      setTab(tabFromQuery)
    }
  }, [actionParamToTab, searchParams, tab])

  useEffect(() => {
    if (!pendingScroll || tab !== 'issues') return
    const target = actionsRef.current
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    requestAnimationFrame(() => {
      issuesHeadingRef.current?.focus({ preventScroll: true })
      setHighlightIssues(true)
      setTimeout(() => setHighlightIssues(false), 1200)
    })
    setPendingScroll(false)
  }, [pendingScroll, tab])

  const createNextStep = async () => {
    if (!workOrderQuery.data) return
    const bom = nextStepBomsQuery.data?.data.find((b) => b.id === selectedBomId)
    if (!bom) {
      setCreateWarning('Select a BOM')
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
      bomId: bom.id,
      outputItemId: bom.outputItemId,
      outputUom: bom.defaultUom,
      quantityPlanned: qty,
      defaultConsumeLocationId: consumeLoc || undefined,
      defaultProduceLocationId: produceLoc || undefined,
    })
    setShowNextStep(false)
    setSelectedBomId('')
    setNextQuantity(1)
    navigate(`/work-orders/${next.id}`)
  }

  const executionQuery = useWorkOrderExecution(id)
  const descriptionBase = workOrderQuery.data?.description ?? ''
  const hasDescriptionChanges = descriptionDraft !== descriptionBase

  useEffect(() => {
    setDescriptionDraft(workOrderQuery.data?.description ?? '')
  }, [workOrderQuery.data?.description])

  const isDisassembly = workOrderQuery.data?.kind === 'disassembly'
  const requirementsQuery = useWorkOrderRequirements(id, undefined, {
    staleTime: 60_000,
    enabled: Boolean(id) && Boolean(workOrderQuery.data) && !isDisassembly,
  })

  const activeBomInfo = useMemo(() => {
    const boms = bomsByItemQuery.data?.boms ?? []
    for (const bom of boms) {
      const version = bom.versions.find((entry) => entry.status === 'active')
      if (version) return { bom, version }
    }
    return null
  }, [bomsByItemQuery.data])

  const activeVersionId = activeBomInfo?.version.id ?? requirementsQuery.data?.bomVersionId ?? null
  const activeVersionLabel = activeBomInfo?.version.versionNumber ?? null
  const activeBomCode = activeBomInfo?.bom.bomCode ?? null

  const usedBomVersion = useMemo(() => {
    const usedId =
      workOrderQuery.data?.bomVersionId ?? requirementsQuery.data?.bomVersionId ?? null
    if (!usedId) return null
    return bomQuery.data?.versions.find((version) => version.id === usedId) ?? null
  }, [bomQuery.data, workOrderQuery.data?.bomVersionId, requirementsQuery.data?.bomVersionId])

  const switchBomMutation = useMutation({
    mutationFn: () => useActiveBomVersion(id as string),
    onSuccess: () => {
      setShowBomSwitchConfirm(false)
      setBomSwitchError(null)
      void workOrderQuery.refetch()
      void requirementsQuery.refetch()
      void bomQuery.refetch()
      void bomsByItemQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: ['work-orders'] })
    },
    onError: (err: ApiError | unknown) => {
      const apiErr = err as ApiError
      setBomSwitchError(apiErr?.message ?? 'Failed to switch BOM version.')
    },
  })

  const descriptionMutation = useMutation({
    mutationFn: (nextValue: string) =>
      updateWorkOrderDescription(id as string, { description: nextValue.trim() ? nextValue : null }),
    onSuccess: (updated) => {
      queryClient.setQueryData(workOrdersQueryKeys.detail(id as string), updated)
      void queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.all })
      setDescriptionDraft(updated.description ?? '')
    },
  })

  const refreshAll = (options?: { showSummaryToast?: boolean }) => {
    void workOrderQuery.refetch()
    void executionQuery.refetch()
    if (options?.showSummaryToast) {
      setSummaryFlash(true)
    }
  }

  const remaining = useMemo(() => {
    if (!workOrderQuery.data) return 0
    return Math.max(
      0,
      (workOrderQuery.data.quantityPlanned || 0) - (workOrderQuery.data.quantityCompleted ?? 0),
    )
  }, [workOrderQuery.data])
  const issuedTotal = useMemo(() => {
    if (!executionQuery.data?.issuedTotals?.length) return 0
    return executionQuery.data.issuedTotals.reduce((sum, row) => sum + (row.quantityIssued || 0), 0)
  }, [executionQuery.data])
  const hasIssued = issuedTotal > 0
  const currentStep = !hasIssued ? 1 : remaining > 0 ? 2 : 3
  const nextStepAvailable = !isDisassembly && (nextStepBomsQuery.data?.data?.length ?? 0) > 0
  const locationsById = useMemo(() => {
    const map = new Map<string, { code?: string; name?: string }>()
    locationsQuery.data?.data?.forEach((loc) => {
      map.set(loc.id, { code: loc.code, name: loc.name })
    })
    return map
  }, [locationsQuery.data])

  const atpQuery = useQuery({
    queryKey: ['atp', workOrderQuery.data?.outputItemId],
    queryFn: () => getAtp({ itemId: workOrderQuery.data?.outputItemId ?? undefined }),
    enabled: Boolean(workOrderQuery.data?.outputItemId),
    staleTime: 30_000,
  })

  const atpRows: AtpResult[] = (atpQuery.data?.data ?? []) as AtpResult[]
  const totalOnHand = atpRows.reduce((sum, row) => sum + (row.onHand ?? 0), 0)
  const totalReserved = atpRows.reduce((sum, row) => sum + (row.reserved ?? 0), 0)
  const totalAvailable = atpRows.reduce((sum, row) => sum + (row.availableToPromise ?? 0), 0)

  const defaultConsumeLocationLabel = useMemo(() => {
    const id = workOrderQuery.data?.defaultConsumeLocationId || outputItemQuery.data?.defaultLocationId
    if (!id) return 'Unassigned'
    const loc = locationsById.get(id)
    if (loc?.code && loc?.name) return `${loc.code} — ${loc.name}`
    return loc?.name || loc?.code || 'Unassigned'
  }, [locationsById, outputItemQuery.data?.defaultLocationId, workOrderQuery.data?.defaultConsumeLocationId])

  const consumeLocationHint = workOrderQuery.data
    ? `Consume location defaults to ${defaultConsumeLocationLabel}.`
    : ''

  const preferredConsumeLocation = useMemo(() => {
    const defaultId = workOrderQuery.data?.defaultConsumeLocationId || outputItemQuery.data?.defaultLocationId
    const matchesDefault = atpRows.find((row) => row.locationId === defaultId && row.availableToPromise > 0)
    if (matchesDefault) return matchesDefault
    return atpRows.find((row) => row.availableToPromise > 0) ?? null
  }, [atpRows, outputItemQuery.data?.defaultLocationId, workOrderQuery.data?.defaultConsumeLocationId])

  const nextStepMessage = useMemo(() => {
    if (!workOrderQuery.data) return ''
    if (!preferredConsumeLocation) {
      return 'No available inventory to consume for disassembly.'
    }
    const locationLabel = `${preferredConsumeLocation.locationCode} — ${preferredConsumeLocation.locationName}`
    const itemLabelText = itemLabel(workOrderQuery.data.outputItemId)
    return `Consume ${formatNumber(Math.max(0, remaining))} ${workOrderQuery.data.outputUom} of ${itemLabelText} from ${locationLabel} to begin disassembly.`
  }, [itemLabel, preferredConsumeLocation, remaining, workOrderQuery.data])

  useEffect(() => {
    if (!summaryFlash) return
    const timeout = setTimeout(() => setSummaryFlash(false), 4000)
    return () => clearTimeout(timeout)
  }, [summaryFlash])

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
      {workOrderQuery.data && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data!.id)}`)}
          >
            View movements
          </Button>
        </div>
      )}

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

      {workOrderQuery.data && (
        <Section title="Inventory status">
          <Card>
            <div className="grid gap-3 text-sm md:grid-cols-5">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">On hand</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatNumber(totalOnHand)} {workOrderQuery.data.outputUom}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Reserved</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatNumber(totalReserved)} {workOrderQuery.data.outputUom}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Available</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {formatNumber(totalAvailable)} {workOrderQuery.data.outputUom}
                </div>
              </div>
              <div className="md:col-span-2">
                <div className="text-xs uppercase tracking-wide text-slate-500">Default consume location</div>
                <div className="mt-1 font-semibold text-slate-900">{defaultConsumeLocationLabel}</div>
              </div>
            </div>
            {isDisassembly && totalAvailable <= 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                No available inventory to consume for disassembly.
              </div>
            )}
          </Card>
        </Section>
      )}

      {workOrderQuery.data && (
        <Section title="Description">
          <Card>
            <div className="space-y-3">
              <Textarea
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                placeholder="Optional note for humans"
                disabled={descriptionMutation.isPending}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDescriptionDraft(descriptionBase)}
                  disabled={!hasDescriptionChanges || descriptionMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => descriptionMutation.mutate(descriptionDraft)}
                  disabled={!hasDescriptionChanges || descriptionMutation.isPending}
                >
                  Save description
                </Button>
              </div>
              {descriptionMutation.isError && (
                <Alert
                  variant="error"
                  title="Update failed"
                  message={(descriptionMutation.error as ApiError)?.message ?? 'Failed to update description.'}
                />
              )}
            </div>
          </Card>
        </Section>
      )}

      <Section title="Execution summary">
        {summaryFlash && (
          <Alert variant="success" title="Summary updated" message="Execution totals refreshed." />
        )}
        <ExecutionSummaryPanel
          summary={executionQuery.data}
          isLoading={executionQuery.isLoading}
          isError={executionQuery.isError}
          onRetry={() => void executionQuery.refetch()}
          errorMessage={executionQuery.error?.message}
        />
      </Section>

      {workOrderQuery.data && (
        <Section title="Primary execution path">
          {isDisassembly && (
            <Card>
              <div className="flex items-start gap-3">
                <div className="mt-1 text-lg">🔧</div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-slate-900">Next step</div>
                  <div className="mt-1 text-sm text-slate-700">{nextStepMessage}</div>
                    <div className="mt-3">
                    <Button size="sm" onClick={goToIssues} disabled={!preferredConsumeLocation}>
                      Consume parent item
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                step: 1,
                title: isDisassembly ? 'Consume parent item' : 'Use materials',
                detail: isDisassembly ? 'Consume the item being disassembled.' : 'Issue components to start work.',
                cta: isDisassembly ? 'Consume' : 'Issue materials',
                onClick: goToIssues,
              },
              {
                step: 2,
                title: isDisassembly ? 'Produce components' : 'Make product',
                detail: isDisassembly ? 'Record recovered components as outputs.' : 'Post completions as output is produced.',
                cta: isDisassembly ? 'Record outputs' : 'Post completion',
                onClick: () => updateTab('completions'),
              },
              {
                step: 3,
                title: 'Review & continue',
                detail: remaining === 0 ? 'Finish this step or continue production.' : 'Review movements and next steps.',
                cta: remaining === 0 && nextStepAvailable ? 'Create next step WO' : 'View movements',
                onClick: () => {
                  if (remaining === 0 && nextStepAvailable) {
                    setShowNextStep(true)
                  } else if (workOrderQuery.data) {
                    navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data.id)}`)
                  }
                },
              },
            ].map((step) => (
              <div
                key={step.step}
                className={`rounded-lg border px-4 py-3 ${
                  currentStep === step.step ? 'border-brand-400 bg-brand-50' : 'border-slate-200'
                }`}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Step {step.step}
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{step.title}</div>
                <div className="mt-1 text-xs text-slate-600">{step.detail}</div>
                <Button
                  size="sm"
                  variant={currentStep === step.step ? 'primary' : 'secondary'}
                  className="mt-3"
                  onClick={step.onClick}
                >
                  {step.cta}
                </Button>
              </div>
            ))}
          </div>
        </Section>
      )}

      {!isDisassembly && (
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
              {usedBomVersion && (
                <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">BOM version used</div>
                      <div className="mt-1 font-semibold text-slate-900">
                        v{usedBomVersion.versionNumber}{' '}
                        <span className="text-slate-500">({usedBomVersion.status})</span>
                      </div>
                      {activeVersionId && activeVersionId !== usedBomVersion.id && (
                        <div className="mt-1 text-xs text-slate-600">
                          Active BOM:{' '}
                          {activeBomCode ? `${activeBomCode} ` : ''}
                          {activeVersionLabel ? `v${activeVersionLabel}` : 'current'}.{' '}
                          <button
                            type="button"
                            className="font-semibold text-brand-700 underline"
                            onClick={() => navigate(`/items/${workOrderQuery.data?.outputItemId}`)}
                          >
                            View active BOM
                          </button>
                        </div>
                      )}
                    </div>
                    {activeVersionId &&
                      activeVersionId !== usedBomVersion.id && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setBomSwitchError(null)
                            setShowBomSwitchConfirm(true)
                          }}
                        >
                          Switch to active
                        </Button>
                      )}
                  </div>
                </div>
              )}
              <WorkOrderRequirementsTable
                lines={requirementsQuery.data.lines}
                issuedTotals={executionQuery.data.issuedTotals}
                componentLabel={componentLabel}
              />
            </Card>
          )}
        </Section>
      )}

      <Section title="Actions">
        <div id="work-order-actions" ref={actionsRef} className="scroll-mt-24">
          <div className="flex gap-2 border-b border-slate-200">
            {(['summary', 'issues', 'completions', 'batch'] as TabKey[]).map((key) => (
              <button
                key={key}
                className={`px-3 py-2 text-sm font-semibold ${
                  tab === key ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-600'
                }`}
                onClick={() => updateTab(key)}
              >
                {key === 'summary'
                  ? 'Overview'
                  : key === 'issues'
                    ? isDisassembly
                      ? 'Consume parent item'
                      : 'Use materials'
                    : key === 'completions'
                      ? isDisassembly
                        ? 'Produce components'
                        : 'Make product'
                      : isDisassembly
                        ? 'Disassemble & record outputs'
                        : 'Issue & complete'}
              </button>
            ))}
          </div>

          {tab === 'summary' && (
            <Card>
              <div className="text-sm text-slate-700">
                {isDisassembly
                  ? 'Consume the parent item, then record recovered components as outputs. Posting creates inventory movements and cannot be edited.'
                  : 'Use materials to issue components, then make product to post completions. Posting creates inventory movements and cannot be edited.'}{' '}
                <span className="font-semibold">
                  {isDisassembly ? 'Remaining to disassemble' : 'Remaining to complete'}:{' '}
                  {remaining} {workOrderQuery.data?.outputUom}
                </span>
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
            <div
              id="use-materials"
              className={`mt-4 rounded-lg border p-4 transition-colors ${
                highlightIssues ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white'
              }`}
            >
              <h3
                ref={issuesHeadingRef}
                tabIndex={-1}
                className="text-sm font-semibold text-slate-900 focus:outline-none"
              >
                {isDisassembly ? 'Consume parent item' : 'Use materials'}
              </h3>
              <div className="mt-3">
                <IssueDraftForm
                  workOrder={workOrderQuery.data}
                  outputItem={outputItemQuery.data}
                  onRefetch={refreshAll}
                />
              </div>
            </div>
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

          {!isDisassembly && workOrderQuery.data && (
            <div className="mt-4">
              {remaining === 0 || showNextStep ? (
                <WorkOrderNextStepPanel
                  isOpen={true}
                  selectedBomId={selectedBomId}
                  nextQuantity={nextQuantity}
                  nextBomOptions={nextBomOptions}
                  isLoading={nextStepBomsQuery.isLoading}
                  isError={nextStepBomsQuery.isError}
                  error={nextStepBomsQuery.error as ApiError}
                  createWarning={createWarning}
                  consumeLocationHint={consumeLocationHint}
                  onBomChange={setSelectedBomId}
                  onQuantityChange={setNextQuantity}
                  onCreate={createNextStep}
                  onCancel={() => setShowNextStep(false)}
                />
              ) : (
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">Continue production</div>
                      <div className="text-xs text-slate-500">
                        Create the next work order from the active BOM.
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setShowNextStep(true)}>
                      Next step…
                    </Button>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      </Section>

      <Modal
        isOpen={showBomSwitchConfirm}
        onClose={() => setShowBomSwitchConfirm(false)}
        title="Switch to active BOM version?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowBomSwitchConfirm(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => switchBomMutation.mutate()}
              disabled={switchBomMutation.isPending}
            >
              Switch to active
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            This will update the work order to use the current active BOM version. The change is
            audited and does not modify any posted issues or completions.
          </p>
          {activeVersionId && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Active BOM: {activeBomCode ? `${activeBomCode} ` : ''}{activeVersionLabel ? `v${activeVersionLabel}` : 'current'}
            </div>
          )}
          {bomSwitchError && <Alert variant="error" title="Switch failed" message={bomSwitchError} />}
        </div>
      </Modal>

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
