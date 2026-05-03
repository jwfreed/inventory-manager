import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useItem, useItemsList } from '@features/items/queries'
import { useBom, useBomsByItem, useNextStepBoms } from '@features/boms/queries'
import { ledgerQueryKeys, useMovementsList } from '@features/ledger/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelWorkOrder,
  closeWorkOrder,
  createWorkOrder,
  markWorkOrderReady,
  updateWorkOrderDescription,
  useActiveBomVersion as activateWorkOrderBomVersion,
  voidWorkOrderProductionReport,
} from '../api/workOrders'
import type { ApiError } from '@api/types'
import {
  useWorkOrder,
  useWorkOrderDisassemblyPlan,
  useWorkOrderExecution,
  useWorkOrderReadiness,
  useWorkOrderRequirements,
  workOrdersQueryKeys,
} from '../queries'
import {
  Alert,
  ActionGuardMessage,
  Banner,
  Button,
  ContextRail,
  EmptyState,
  EntityPageLayout,
  ErrorState,
  Input,
  LoadingSpinner,
  Modal,
  OperationTimeline,
  PageHeader,
  Panel,
  SectionNav,
  Textarea,
} from '@shared/ui'
import { WorkOrderHeader } from '../components/WorkOrderHeader'
import { ExecutionSummaryPanel } from '../components/ExecutionSummaryPanel'
import { WorkOrderExecutionWorkspace } from '../components/WorkOrderExecutionWorkspace'
import { WorkOrderLifecycleActions } from '../components/WorkOrderLifecycleActions'
import { WorkOrderCancelModal } from '../components/WorkOrderCancelModal'
import { WorkOrderRequirementsTable } from '../components/WorkOrderRequirementsTable'
import { WorkOrderNextStepPanel } from '../components/WorkOrderNextStepPanel'
import { useLocationsList } from '@features/locations/queries'
import { getAtp } from '@api/reports'
import type { AtpResult } from '@api/types'
import { formatNumber } from '@shared/formatters'
import {
  type RecentProductionReportCandidate,
  getWorkOrderActionPolicy,
} from '../lib/workOrderActionPolicy'
import {
  formatWorkOrderError,
  formatWorkOrderLifecycleError,
} from '../lib/workOrderErrorMessaging'
import { getWorkOrderOperationalHistoryItems } from '../lib/workOrderOperationalHistory'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'
import { useAuth } from '@shared/auth'

const workOrderDetailSections = [
  { id: 'overview', label: 'Overview' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'execution', label: 'Execution' },
  { id: 'requirements', label: 'Requirements' },
  { id: 'actions', label: 'Actions' },
] as const

export default function WorkOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const [showNextStep, setShowNextStep] = useState(false)
  const [selectedBomId, setSelectedBomId] = useState('')
  const [nextQuantity, setNextQuantity] = useState<number | ''>(1)
  const [createWarning, setCreateWarning] = useState<string | null>(null)
  const [showBomSwitchConfirm, setShowBomSwitchConfirm] = useState(false)
  const [bomSwitchError, setBomSwitchError] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [summaryFlash, setSummaryFlash] = useState(false)
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showVoidConfirm, setShowVoidConfirm] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidNotes, setVoidNotes] = useState('')
  const [recentProductionReport, setRecentProductionReport] =
    useState<RecentProductionReportCandidate | null>(null)

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

  const scrollToExecutionWorkspace = useCallback(() => {
    if (typeof actionsRef.current?.scrollIntoView === 'function') {
      actionsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

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
  const operationalHistoryQuery = useMovementsList(
    { externalRef: id, limit: 100 },
    {
      enabled: Boolean(id) && Boolean(workOrderQuery.data),
      staleTime: 30_000,
    },
  )
  const descriptionBase = workOrderQuery.data?.description ?? ''
  const hasDescriptionChanges = descriptionDraft !== descriptionBase

  useEffect(() => {
    setDescriptionDraft(workOrderQuery.data?.description ?? '')
  }, [workOrderQuery.data?.description])

  useEffect(() => {
    setRecentProductionReport(null)
    setLifecycleMessage(null)
    setLifecycleError(null)
    setShowCancelConfirm(false)
    setShowCloseConfirm(false)
    setShowVoidConfirm(false)
    setVoidReason('')
    setVoidNotes('')
  }, [id])

  const isDisassembly = workOrderQuery.data?.kind === 'disassembly'
  const readinessQuery = useWorkOrderReadiness(id, {
    enabled: Boolean(id) && Boolean(workOrderQuery.data),
    staleTime: 10_000,
  })
  const disassemblyPlanQuery = useWorkOrderDisassemblyPlan(id, undefined, {
    enabled: Boolean(id) && Boolean(workOrderQuery.data) && isDisassembly,
    staleTime: 10_000,
  })
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
    mutationFn: () => activateWorkOrderBomVersion(id as string),
    onSuccess: async () => {
      setShowBomSwitchConfirm(false)
      setBomSwitchError(null)
      void workOrderQuery.refetch()
      void requirementsQuery.refetch()
      void bomQuery.refetch()
      void bomsByItemQuery.refetch()
      await invalidateWorkOrderQueries()
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

  const invalidateWorkOrderQueries = async () => {
    if (!id) return
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.execution(id) }),
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.readiness(id) }),
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.requirements(id) }),
      queryClient.invalidateQueries({ queryKey: workOrdersQueryKeys.disassemblyPlan(id) }),
      queryClient.invalidateQueries({ queryKey: ledgerQueryKeys.all }),
    ])
  }

  const readyMutation = useMutation({
    mutationFn: () => markWorkOrderReady(id as string),
    onSuccess: async (updated) => {
      setLifecycleError(null)
      setLifecycleMessage(`${updated.number} is ready for production.`)
      await invalidateWorkOrderQueries()
    },
    onError: (err) => {
      logOperationalMutationFailure('work-orders', 'ready-work-order', err, { workOrderId: id })
      setLifecycleMessage(null)
      setLifecycleError(
        formatWorkOrderLifecycleError(err, 'Failed to ready the work order.'),
      )
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () => cancelWorkOrder(id as string),
    onSuccess: async (updated) => {
      setLifecycleError(null)
      setLifecycleMessage(`${updated.number} was canceled.`)
      setShowCancelConfirm(false)
      setRecentProductionReport(null)
      await invalidateWorkOrderQueries()
    },
    onError: (err) => {
      logOperationalMutationFailure('work-orders', 'cancel-work-order', err, { workOrderId: id })
      setLifecycleMessage(null)
      setLifecycleError(
        formatWorkOrderLifecycleError(err, 'Failed to cancel the work order.'),
      )
    },
  })

  const closeMutation = useMutation({
    mutationFn: () => closeWorkOrder(id as string),
    onSuccess: async (updated) => {
      setLifecycleError(null)
      setLifecycleMessage(`${updated.number} was closed.`)
      setShowCloseConfirm(false)
      await invalidateWorkOrderQueries()
    },
    onError: (err) => {
      logOperationalMutationFailure('work-orders', 'close-work-order', err, { workOrderId: id })
      setLifecycleMessage(null)
      setLifecycleError(
        formatWorkOrderLifecycleError(err, 'Failed to close the work order.'),
      )
    },
  })

  const voidMutation = useMutation({
    mutationFn: () =>
      voidWorkOrderProductionReport(id as string, {
        workOrderExecutionId: recentProductionReport?.workOrderExecutionId ?? '',
        reason: voidReason.trim(),
        notes: voidNotes.trim() || null,
      }),
    onSuccess: async () => {
      setLifecycleError(null)
      setLifecycleMessage('Recent production report was voided.')
      setShowVoidConfirm(false)
      setVoidReason('')
      setVoidNotes('')
      setRecentProductionReport(null)
      await invalidateWorkOrderQueries()
    },
    onError: (err) => {
      logOperationalMutationFailure('work-orders', 'void-production-report', err, {
        workOrderId: id,
        workOrderExecutionId: recentProductionReport?.workOrderExecutionId ?? null,
      })
      setLifecycleMessage(null)
      setLifecycleError(
        formatWorkOrderLifecycleError(err, 'Failed to void the production report.'),
      )
    },
  })

  const canWriteWorkOrder = hasPermission('production:write') && !!workOrderQuery.data

  const handleMarkReady = () => {
    if (!canWriteWorkOrder) return
    setLifecycleMessage(null)
    setLifecycleError(null)
    readyMutation.mutate()
  }

  const handleSaveDescription = () => {
    if (!canWriteWorkOrder) return
    descriptionMutation.mutate(descriptionDraft)
  }

  const handleCancelConfirm = () => {
    if (!canWriteWorkOrder) return
    cancelMutation.mutate()
  }

  const handleCloseConfirm = () => {
    if (!canWriteWorkOrder) return
    closeMutation.mutate()
  }

  const handleVoidConfirm = () => {
    if (!canWriteWorkOrder) return
    voidMutation.mutate()
  }

  const handleSwitchBom = () => {
    if (!canWriteWorkOrder) return
    switchBomMutation.mutate()
  }

  const refreshAll = (options?: { showSummaryToast?: boolean }) => {
    void workOrderQuery.refetch()
    void executionQuery.refetch()
    void operationalHistoryQuery.refetch()
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
  const actionPolicy = useMemo(
    () => getWorkOrderActionPolicy(workOrderQuery.data ?? null, recentProductionReport),
    [recentProductionReport, workOrderQuery.data],
  )
  const operationalHistoryItems = useMemo(
    () =>
      id ? getWorkOrderOperationalHistoryItems(operationalHistoryQuery.data?.data ?? [], id) : [],
    [id, operationalHistoryQuery.data],
  )
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

  const atpRows = useMemo(() => (atpQuery.data?.data ?? []) as AtpResult[], [atpQuery.data?.data])
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

  const healthContent = workOrderQuery.data ? (
    <div className="space-y-3">
      {isDisassembly && totalAvailable <= 0 ? (
        <Banner
          severity="action"
          title="No usable inventory for disassembly"
          description="This work order cannot start until inventory is available to consume."
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data!.id)}`)
                }
              >
                View movements
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  navigate(
                    `/inventory-adjustments/new?itemId=${encodeURIComponent(workOrderQuery.data!.outputItemId)}`,
                  )
                }
              >
                Adjust stock
              </Button>
            </div>
          }
        />
      ) : null}
      {!isDisassembly && activeVersionId && usedBomVersion && activeVersionId !== usedBomVersion.id ? (
        <Banner
          severity="action"
          title="Work order is using an older BOM version"
          description="Active BOM configuration has changed since this work order was created."
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/items/${workOrderQuery.data!.outputItemId}`)}
              >
                View active BOM
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setBomSwitchError(null)
                  setShowBomSwitchConfirm(true)
                }}
              >
                Switch to active
              </Button>
            </div>
          }
        />
      ) : null}
      {executionQuery.data?.workOrder.completedAt ? (
        <Banner
          severity="info"
          title="Work order completed"
          description={`Completed at ${executionQuery.data.workOrder.completedAt}.`}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data!.id)}`)
              }
            >
              View movements
            </Button>
          }
        />
      ) : null}
    </div>
  ) : undefined

  const contextSections = workOrderQuery.data
    ? [
        {
          title: 'Entity identity',
          rows: [
            { label: 'Work order', value: workOrderQuery.data.number },
            { label: 'Output item', value: itemLabel(workOrderQuery.data.outputItemId) || 'Unknown item' },
            { label: 'Kind', value: workOrderQuery.data.kind },
            { label: 'Status', value: workOrderQuery.data.status },
          ],
        },
        {
          title: 'Configuration health',
          rows: [
            { label: 'BOM', value: workOrderQuery.data.bomId ?? '—' },
            { label: 'Used BOM version', value: usedBomVersion ? `v${usedBomVersion.versionNumber}` : '—' },
            { label: 'Active BOM', value: activeVersionLabel ? `v${activeVersionLabel}` : '—' },
            { label: 'Consume location', value: defaultConsumeLocationLabel },
          ],
        },
        {
          title: 'Supporting metadata',
          rows: [
            { label: 'Planned qty', value: `${formatNumber(workOrderQuery.data.quantityPlanned)} ${workOrderQuery.data.outputUom}` },
            { label: 'Completed qty', value: `${formatNumber(workOrderQuery.data.quantityCompleted ?? 0)} ${workOrderQuery.data.outputUom}` },
            { label: 'Remaining', value: `${formatNumber(remaining)} ${workOrderQuery.data.outputUom}` },
          ],
        },
      ]
    : []

  const sectionLinks = isDisassembly
    ? workOrderDetailSections.filter((section) => section.id !== 'requirements')
    : workOrderDetailSections

  return (
    <>
      <EntityPageLayout
        header={
          <section id="overview" className="space-y-6">
            <PageHeader
              title="Work order detail"
              subtitle="Track readiness, execution, and next actions from one operational page."
              action={
                <div className="space-y-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => navigate('/work-orders')}>
                      Back to list
                    </Button>
                    {workOrderQuery.data ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data!.id)}`)
                        }
                      >
                        View movements
                      </Button>
                    ) : null}
                  </div>
                  {workOrderQuery.data ? (
                    <WorkOrderLifecycleActions
                      canMarkReady={actionPolicy.canMarkReady}
                      canCancel={actionPolicy.canCancel}
                      canClose={actionPolicy.canClose}
                      cancelDisabledReason={actionPolicy.cancelDisabledReason}
                      closeDisabledReason={actionPolicy.closeDisabledReason}
                      isMarkReadyPending={readyMutation.isPending}
                      isCancelPending={cancelMutation.isPending}
                      isClosePending={closeMutation.isPending}
                      lifecycleMessage={lifecycleMessage}
                      lifecycleError={lifecycleError}
                      onMarkReady={() => handleMarkReady()}
                      onRequestCancel={() => {
                        setLifecycleMessage(null)
                        setLifecycleError(null)
                        setShowCancelConfirm(true)
                      }}
                      onRequestClose={() => {
                        setLifecycleMessage(null)
                        setLifecycleError(null)
                        setShowCloseConfirm(true)
                      }}
                    />
                  ) : null}
                </div>
              }
            />
            {workOrderQuery.isLoading ? <LoadingSpinner label="Loading work order..." /> : null}
            {workOrderQuery.isError && workOrderQuery.error ? (
              <ErrorState error={workOrderQuery.error} onRetry={() => void workOrderQuery.refetch()} />
            ) : null}
            {workOrderQuery.data ? (
              <WorkOrderHeader
                workOrder={workOrderQuery.data}
                outputItemLabel={itemLabel(workOrderQuery.data.outputItemId)}
              />
            ) : null}
          </section>
        }
        health={healthContent}
        sectionNav={<SectionNav sections={sectionLinks} ariaLabel="Work order sections" />}
        contextRail={<ContextRail sections={contextSections} />}
      >
        {workOrderQuery.data ? (
          <section id="inventory">
            <Panel title="Inventory status" description="Current ATP context for this work order's output item.">
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
            </Panel>
          </section>
        ) : null}

        {workOrderQuery.data ? (
          <section id="execution" className="space-y-6">
            <Panel
              title="Operator notes"
              description="Shift notes only. This does not edit BOM, routing, quantities, or execution-derived history."
            >
              <div className="space-y-3">
                <Textarea
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  placeholder="Optional handoff or execution note"
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
                    onClick={handleSaveDescription}
                    disabled={!hasDescriptionChanges || descriptionMutation.isPending}
                  >
                    Save operator notes
                  </Button>
                </div>
                {descriptionMutation.isError ? (
                  <Alert
                    variant="error"
                    title="Update failed"
                    message={
                      formatWorkOrderError(
                        descriptionMutation.error,
                        'Failed to update operator notes.',
                      )
                    }
                  />
                ) : null}
              </div>
            </Panel>

            <Panel title="Execution summary" description="Issued, completed, and remaining quantities.">
              {summaryFlash ? (
                <Alert variant="success" title="Summary updated" message="Execution totals refreshed." />
              ) : null}
              <ExecutionSummaryPanel
                summary={executionQuery.data}
                isLoading={executionQuery.isLoading}
                isError={executionQuery.isError}
                onRetry={() => void executionQuery.refetch()}
                errorMessage={executionQuery.error?.message}
              />
            </Panel>

            <Panel
              title="Operational History"
              description="Read-only posted activity from the inventory ledger for this work order."
            >
              {operationalHistoryQuery.isLoading ? (
                <LoadingSpinner label="Loading operational history..." />
              ) : operationalHistoryQuery.isError ? (
                <Alert
                  variant="error"
                  title="Operational history unavailable"
                  message={
                    operationalHistoryQuery.error?.message ??
                    'Failed to load operational history for this work order.'
                  }
                />
              ) : (
                <OperationTimeline
                  items={operationalHistoryItems}
                  emptyTitle="No posted activity yet"
                  emptyDescription="Post production, disassembly, or void activity to populate the operational history."
                />
              )}
            </Panel>

            <Panel title="Primary execution path" description="Recommended next step based on current execution state.">
              {isDisassembly ? (
                <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="text-sm font-semibold text-slate-900">Next step</div>
                  <div className="mt-1 text-sm text-slate-700">{nextStepMessage}</div>
                  <div className="mt-3">
                    <Button size="sm" onClick={scrollToExecutionWorkspace} disabled={!preferredConsumeLocation}>
                      Open execution workspace
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-3">
                {[
                  {
                    step: 1,
                    title: 'Component readiness',
                    detail: 'Validate required, reserved, available, and shortage before execution.',
                    cta: 'Review readiness',
                    onClick: scrollToExecutionWorkspace,
                  },
                  {
                    step: 2,
                    title: isDisassembly ? 'Record outputs' : 'Produce output',
                    detail: isDisassembly ? 'Use the workspace to post disassembly outputs.' : 'Post wrapped or boxed output with locked stage routing.',
                    cta: 'Open workspace',
                    onClick: scrollToExecutionWorkspace,
                  },
                  {
                    step: 3,
                    title: 'Review movements',
                    detail: remaining === 0 ? 'Finish this step or continue production.' : 'Confirm deterministic issue and receipt postings.',
                    cta: remaining === 0 && nextStepAvailable ? 'Create next step WO' : 'Review workspace',
                    onClick: () => {
                      if (remaining === 0 && nextStepAvailable) {
                        setShowNextStep(true)
                      } else {
                        scrollToExecutionWorkspace()
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
            </Panel>
          </section>
        ) : null}

        {!isDisassembly ? (
          <section id="requirements">
            <Panel title="Requirements vs issued" description="Compare BOM requirements to issued quantities for each component.">
              {requirementsQuery.isLoading ? <LoadingSpinner label="Loading requirements..." /> : null}
              {requirementsQuery.isError ? (
                <ErrorState
                  error={requirementsQuery.error}
                  onRetry={() => void requirementsQuery.refetch()}
                />
              ) : null}
              {requirementsQuery.data && executionQuery.data ? (
                <div className="space-y-4">
                  {usedBomVersion ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-500">BOM version used</div>
                          <div className="mt-1 font-semibold text-slate-900">
                            v{usedBomVersion.versionNumber}{' '}
                            <span className="text-slate-500">({usedBomVersion.status})</span>
                          </div>
                          {activeVersionId && activeVersionId !== usedBomVersion.id ? (
                            <div className="mt-1 text-xs text-slate-600">
                              Active BOM: {activeBomCode ? `${activeBomCode} ` : ''}
                              {activeVersionLabel ? `v${activeVersionLabel}` : 'current'}.
                            </div>
                          ) : null}
                        </div>
                        {activeVersionId && activeVersionId !== usedBomVersion.id ? (
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
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <WorkOrderRequirementsTable
                    lines={readinessQuery.data?.lines?.length ? readinessQuery.data.lines : requirementsQuery.data.lines}
                    issuedTotals={executionQuery.data.issuedTotals}
                    componentLabel={componentLabel}
                  />
                </div>
              ) : null}
            </Panel>
          </section>
        ) : null}

        <section id="actions">
          <Panel title="Execution workspace" description="Locked routing, readiness, deterministic posting, and movement review in one place.">
            <div id="work-order-actions" ref={actionsRef} className="scroll-mt-24">
              {workOrderQuery.data && actionPolicy.executionLocked ? (
                <ActionGuardMessage
                  title="Execution locked"
                  message={actionPolicy.executionLockedReason}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        navigate(`/movements?externalRef=${encodeURIComponent(workOrderQuery.data.id)}`)
                      }
                    >
                      View movements
                    </Button>
                  }
                />
              ) : workOrderQuery.data && !isDisassembly ? (
                <WorkOrderExecutionWorkspace
                  workOrder={workOrderQuery.data}
                  readiness={readinessQuery.data}
                  disassemblyPlan={disassemblyPlanQuery.data}
                  isLoading={readinessQuery.isLoading}
                  isError={readinessQuery.isError}
                  errorMessage={readinessQuery.error?.message}
                  onRefresh={refreshAll}
                  onProductionReported={(result, meta) => {
                    if (meta.scrapPosted) {
                      setRecentProductionReport(null)
                      return
                    }
                    setRecentProductionReport({
                      workOrderExecutionId: result.productionReportId,
                      productionReportId: result.productionReportId,
                      occurredAt: meta.occurredAt,
                      notes: meta.notes,
                      scrapPosted: meta.scrapPosted,
                    })
                  }}
                />
              ) : workOrderQuery.data ? (
                <WorkOrderExecutionWorkspace
                  workOrder={workOrderQuery.data}
                  readiness={readinessQuery.data}
                  disassemblyPlan={disassemblyPlanQuery.data}
                  isLoading={readinessQuery.isLoading || disassemblyPlanQuery.isLoading}
                  isError={readinessQuery.isError || disassemblyPlanQuery.isError}
                  errorMessage={readinessQuery.error?.message ?? disassemblyPlanQuery.error?.message}
                  onRefresh={refreshAll}
                />
              ) : (
                <EmptyState
                  title="No execution yet"
                  description="Create or load a work order to begin execution."
                />
              )}
            </div>

            {workOrderQuery.data && (
              <div className="mt-4">
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">Recent production report</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Only the most recent report from this page session can be voided.
                      </div>
                    </div>
                    {actionPolicy.canVoidRecentReport && recentProductionReport ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setLifecycleMessage(null)
                          setLifecycleError(null)
                          setShowVoidConfirm(true)
                        }}
                      >
                        Void Production Report
                      </Button>
                    ) : null}
                  </div>
                  {recentProductionReport ? (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                      <div className="font-semibold text-slate-900">
                        Execution {recentProductionReport.workOrderExecutionId}
                      </div>
                      <div className="mt-1">
                        Reported at {recentProductionReport.occurredAt ?? 'Unknown time'}
                      </div>
                      {recentProductionReport.notes ? (
                        <div className="mt-1">Notes: {recentProductionReport.notes}</div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-slate-600">
                      Post production from this page to enable the recent-report void action.
                    </div>
                  )}
                  {!actionPolicy.canVoidRecentReport && actionPolicy.voidRecentReportDisabledReason ? (
                    <div className="mt-3 text-xs text-slate-500">
                      {actionPolicy.voidRecentReportDisabledReason}
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {!isDisassembly && workOrderQuery.data && !actionPolicy.executionLocked && (
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
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
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
                </div>
	              )}
	            </div>
	          )}
	          </Panel>
	        </section>
      </EntityPageLayout>

      <WorkOrderCancelModal
        isOpen={showCancelConfirm}
        workOrder={workOrderQuery.data}
        isPending={cancelMutation.isPending}
        errorMessage={showCancelConfirm ? lifecycleError : null}
        onCancel={() => setShowCancelConfirm(false)}
        onConfirm={handleCancelConfirm}
      />

      <Modal
        isOpen={showCloseConfirm}
        onClose={() => setShowCloseConfirm(false)}
        title="Close Work Order?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowCloseConfirm(false)}>
              Keep Open
            </Button>
            <Button size="sm" onClick={handleCloseConfirm} disabled={closeMutation.isPending}>
              {closeMutation.isPending ? 'Closing...' : 'Confirm Close Work Order'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            Closing finalizes the completed work order and prevents further lifecycle actions from
            the UI.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            {workOrderQuery.data?.number ?? 'Work order'}
          </div>
          {showCloseConfirm && lifecycleError ? (
            <Alert variant="error" title="Close failed" message={lifecycleError} />
          ) : null}
        </div>
      </Modal>

      <Modal
        isOpen={showVoidConfirm}
        onClose={() => setShowVoidConfirm(false)}
        title="Void Production Report?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowVoidConfirm(false)}>
              Keep Report
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={handleVoidConfirm}
              disabled={voidMutation.isPending || !voidReason.trim()}
            >
              {voidMutation.isPending ? 'Voiding...' : 'Confirm Void Production Report'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            This reverses the most recent production report from this page session if the output has
            not moved out of QA.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <div className="font-semibold text-slate-900">
              Execution {recentProductionReport?.workOrderExecutionId ?? 'Unavailable'}
            </div>
            {recentProductionReport?.occurredAt ? (
              <div className="mt-1">Reported at {recentProductionReport.occurredAt}</div>
            ) : null}
          </div>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Reason</span>
            <Input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm text-slate-700">
            <span className="font-medium">Notes</span>
            <Textarea value={voidNotes} onChange={(event) => setVoidNotes(event.target.value)} />
          </label>
          {showVoidConfirm && lifecycleError ? (
            <Alert variant="error" title="Void failed" message={lifecycleError} />
          ) : null}
        </div>
      </Modal>

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
              onClick={handleSwitchBom}
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
    </>
  )
}
