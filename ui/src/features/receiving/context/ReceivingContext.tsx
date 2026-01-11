import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@shared/auth'
import { useDebouncedValue } from '@shared'
import { purchaseOrdersQueryKeys, usePurchaseOrder, usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { useLocationsList } from '@features/locations/queries'
import { createReceipt, voidReceiptApi, type ReceiptCreatePayload } from '../api/receipts'
import { createPutaway, postPutaway, type PutawayCreatePayload } from '../api/putaways'
import { createQcEvent, type QcEventCreatePayload } from '../api/qc'
import { receivingQueryKeys, usePutaway, useQcEventsForLine, useReceipt, useReceiptsList } from '../queries'
import { buildReceiptLines, getQcBreakdown } from '../utils'
import type { PutawayLineInput, QcDraft, ReceiptLineInput, ReceiptLineOption, ReceiptLineSummary } from '../types'
import type { PurchaseOrderReceiptLine, PurchaseOrderReceipt, QcEvent, Putaway } from '@api/types'
import type { ReceivingFilters } from '../components/SearchFiltersBar'
import { useOfflineQueue } from '../hooks/useOfflineQueue'
import type { OfflineOperation } from '../lib/indexedDB'
import { DISCREPANCY_LABELS } from './constants'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type WorkflowStep = 'receipt' | 'qc' | 'putaway'

export type StepperState = {
  key: WorkflowStep
  label: string
  complete: boolean
  blocked: string | null
}

type LocationOption = {
  value: string
  label: string
  keywords: string
}

type PurchaseOrderOption = {
  value: string
  label: string
  keywords: string
}

export type ReceivingContextValue = {
  // ── URL Params ──
  searchParams: URLSearchParams
  updateReceivingParams: (updates: { receiptId?: string; putawayId?: string; qcLineId?: string }) => void

  // ── Receipt Step State ──
  selectedPoId: string
  setSelectedPoId: (id: string) => void
  handlePoChange: (nextId: string) => void
  receiptLineInputs: ReceiptLineInput[]
  setReceiptLineInputs: React.Dispatch<React.SetStateAction<ReceiptLineInput[] | null>>
  updateReceiptLine: (lineId: string, patch: Partial<ReceiptLineInput>) => void
  resetReceiptLines: () => void
  receiptNotes: string
  setReceiptNotes: (notes: string) => void
  receivedToLocationId: string | null
  setReceivedToLocationId: (id: string | null) => void
  resolvedReceivedToLocationId: string
  receiptLineSummary: ReceiptLineSummary

  // ── Receipt Queries ──
  poListQuery: ReturnType<typeof usePurchaseOrdersList>
  poQuery: ReturnType<typeof usePurchaseOrder>
  poOptions: PurchaseOrderOption[]
  poClosed: boolean

  // ── Receipt Mutations ──
  receiptMutation: ReturnType<typeof useMutation<PurchaseOrderReceipt, unknown, ReceiptCreatePayload>>
  voidReceiptMutation: ReturnType<typeof useMutation<void, unknown, string>>
  onCreateReceipt: (e: React.FormEvent) => void
  canPostReceipt: boolean
  receiptPostedForSelectedPo: boolean

  // ── QC Step State ──
  receiptIdForQc: string
  setReceiptIdForQc: (id: string) => void
  loadReceiptForQc: (id: string) => void
  selectedQcLineId: string
  setSelectedQcLineId: (id: string) => void
  activeQcLineId: string
  selectedQcLine: PurchaseOrderReceiptLine | undefined
  qcDraft: QcDraft
  updateQcDraft: (patch: Partial<QcDraft>) => void
  lastQcEvent: QcEvent | null
  setLastQcEvent: (event: QcEvent | null) => void
  qcLines: PurchaseOrderReceiptLine[]
  qcStats: { accept: number; hold: number; reject: number; remaining: number } | null
  qcRemaining: number
  qcEventType: 'accept' | 'hold' | 'reject'
  qcQuantity: number | ''
  qcReasonCode: string
  qcNotes: string
  qcQuantityInvalid: boolean
  canRecordQc: boolean

  // ── QC Queries ──
  receiptQuery: ReturnType<typeof useReceipt>
  qcEventsQuery: ReturnType<typeof useQcEventsForLine>
  qcEventsList: QcEvent[]
  recentReceiptsQuery: ReturnType<typeof useReceiptsList>

  // ── QC Mutations ──
  qcEventMutation: ReturnType<typeof useMutation<QcEvent, unknown, QcEventCreatePayload>>
  onCreateQcEvent: () => void

  // ── Putaway Step State ──
  putawayLines: PutawayLineInput[]
  setPutawayLines: React.Dispatch<React.SetStateAction<PutawayLineInput[]>>
  addPutawayLine: () => void
  updatePutawayLine: (idx: number, patch: Partial<PutawayLineInput>) => void
  fillPutawayFromReceipt: () => void
  resolvePutawayDefaults: (opts: { defaultFromLocationId?: string; defaultToLocationId?: string }) => { fromId: string; toId: string }
  putawayId: string
  setPutawayId: (id: string) => void
  putawayFillNotice: string | null
  setPutawayFillNotice: (notice: string | null) => void
  putawayResumeNotice: string | null
  receiptLineOptions: ReceiptLineOption[]
  putawayQcIssues: { idx: number; label: string; reason: string }[]
  putawayQuantityIssues: { idx: number; label: string; availableQty: number }[]
  canCreatePutaway: boolean

  // ── Putaway Queries ──
  putawayQuery: ReturnType<typeof usePutaway>
  locationsQuery: ReturnType<typeof useLocationsList>
  locationOptions: LocationOption[]
  locationSearch: string
  setLocationSearch: (search: string) => void

  // ── Putaway Mutations ──
  putawayMutation: ReturnType<typeof useMutation<Putaway, unknown, PutawayCreatePayload>>
  postPutawayMutation: ReturnType<typeof useMutation<Putaway, unknown, string>>
  onCreatePutaway: (e: React.FormEvent) => void

  // ── Workflow State ──
  currentStep: WorkflowStep
  stepper: StepperState[]
  receiptLoaded: boolean
  qcNeedsAttention: boolean
  putawayBlockingLine: PurchaseOrderReceiptLine | undefined
  putawayHasAvailable: boolean
  putawayReady: boolean
  receiptTotals: { received: number; accepted: number; hold: number; reject: number; remaining: number }

  // ── Search and Filters ──
  receivingFilters: ReceivingFilters
  setReceivingFilters: (filters: ReceivingFilters) => void
  filteredReceipts: PurchaseOrderReceipt[]
  filteredReceiptLines: PurchaseOrderReceiptLine[]

  // ── Bulk Operations ──
  selectedReceiptIds: Set<string>
  selectedQcLineIds: Set<string>
  toggleReceiptSelection: (receiptId: string) => void
  toggleQcLineSelection: (lineId: string) => void
  selectAllReceipts: () => void
  selectAllQcLines: () => void
  clearReceiptSelection: () => void
  clearQcLineSelection: () => void
  bulkAcceptQcLines: () => Promise<void>
  bulkHoldQcLines: (reasonCode: string, notes: string) => Promise<void>
  bulkRejectQcLines: (reasonCode: string, notes: string) => Promise<void>
  isBulkProcessing: boolean

  // ── Offline Support ──
  isOnline: boolean
  pendingCount: number
  pendingOperations: OfflineOperation[]
  isSyncing: boolean
  syncPendingOperations: () => Promise<void>
  clearOfflineQueue: () => Promise<void>

  // ── Utilities ──
  getErrorMessage: (error: unknown, fallback: string) => string
  mapErrorMessage: (message: string, map: Record<string, string>) => string
}

// ─────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────

const ReceivingContext = createContext<ReceivingContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useReceivingContext() {
  const context = useContext(ReceivingContext)
  if (!context) {
    throw new Error('useReceivingContext must be used within a ReceivingProvider')
  }
  return context
}

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

type Props = {
  children: ReactNode
}

export function ReceivingProvider({ children }: Props) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── URL Params ──
  const poIdFromQuery = searchParams.get('poId') ?? ''
  const receiptIdFromQuery = searchParams.get('receiptId') ?? ''
  const putawayIdFromQuery = searchParams.get('putawayId') ?? ''
  const qcLineIdFromQuery = searchParams.get('qcLineId') ?? ''

  // ── Receipt Step State ──
  const [selectedPoId, setSelectedPoId] = useState(() => poIdFromQuery)
  const [receiptLineInputs, setReceiptLineInputs] = useState<ReceiptLineInput[] | null>(null)
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receivedToLocationId, setReceivedToLocationId] = useState<string | null>(null)

  // ── QC Step State ──
  const [receiptIdForQc, setReceiptIdForQc] = useState(() => receiptIdFromQuery)
  const [selectedQcLineId, setSelectedQcLineId] = useState(() => qcLineIdFromQuery)
  const [qcDraft, setQcDraft] = useState<QcDraft>({
    lineId: '',
    eventType: 'accept',
    quantity: '',
    reasonCode: '',
    notes: '',
  })
  const [lastQcEvent, setLastQcEvent] = useState<QcEvent | null>(null)

  // ── Putaway Step State ──
  const [putawayLines, setPutawayLines] = useState<PutawayLineInput[]>([
    { purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' },
  ])
  const [locationSearch, setLocationSearch] = useState('')
  const [putawayId, setPutawayId] = useState(() => putawayIdFromQuery)
  const [putawayFillNotice, setPutawayFillNotice] = useState<string | null>(null)
  const [putawayResumeNotice, setPutawayResumeNotice] = useState<string | null>(null)
  const hydratedPutawayId = useRef<string | null>(null)

  // ── Search and Filter State ──
  const [receivingFilters, setReceivingFilters] = useState<ReceivingFilters>({
    searchTerm: '',
    qcStatus: 'all',
    dateRange: 'all',
    hasPriority: false,
    hasDiscrepancies: false,
  })

  // ── Bulk Operations State ──
  const [selectedReceiptIds, setSelectedReceiptIds] = useState<Set<string>>(new Set())
  const [selectedQcLineIds, setSelectedQcLineIds] = useState<Set<string>>(new Set())
  const [isBulkProcessing, setIsBulkProcessing] = useState(false)

  // ── Offline Queue ──
  // Sync handler for offline operations
  const handleOfflineSync = useCallback(async (operation: OfflineOperation) => {
    switch (operation.type) {
      case 'qc-event':
        await createQcEvent(operation.payload as unknown as QcEventCreatePayload)
        break
      case 'putaway-create':
        await createPutaway(operation.payload as unknown as PutawayCreatePayload)
        break
      case 'putaway-post':
        await postPutaway((operation.payload as { putawayId: string }).putawayId)
        break
      case 'receipt-create':
        await createReceipt(operation.payload as unknown as ReceiptCreatePayload)
        break
      default:
        throw new Error(`Unknown operation type: ${(operation as { type: string }).type}`)
    }
  }, [])

  const {
    isOnline,
    pendingCount,
    pendingOperations,
    isSyncing,
    queueOperation,
    syncPendingOperations,
    clearQueue: clearOfflineQueue,
  } = useOfflineQueue(handleOfflineSync)

  // ─────────────────────────────────────────────────────────────
  // Utility Functions
  // ─────────────────────────────────────────────────────────────

  const getErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (!error) return fallback
    if (typeof error === 'string') return error
    if (typeof error === 'object' && 'message' in (error as { message?: unknown })) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim().length > 0) return message
    }
    return fallback
  }, [])

  const mapErrorMessage = useCallback((message: string, map: Record<string, string>) => {
    if (!message) return message
    if (map[message]) return map[message]
    if (message.startsWith('Requested quantity exceeds available putaway quantity')) {
      return 'Reduce the quantity to the remaining available amount.'
    }
    if (message.startsWith('Requested putaway quantity exceeds accepted quantity')) {
      return 'Reduce quantities or record QC acceptance before posting.'
    }
    return message
  }, [])

  // ─────────────────────────────────────────────────────────────
  // URL Param Management
  // ─────────────────────────────────────────────────────────────

  const updateReceivingParams = useCallback(
    (updates: { receiptId?: string; putawayId?: string; qcLineId?: string }) => {
      const params = new URLSearchParams(searchParams)
      if (updates.receiptId !== undefined) {
        if (updates.receiptId) params.set('receiptId', updates.receiptId)
        else params.delete('receiptId')
      }
      if (updates.putawayId !== undefined) {
        if (updates.putawayId) params.set('putawayId', updates.putawayId)
        else params.delete('putawayId')
      }
      if (updates.qcLineId !== undefined) {
        if (updates.qcLineId) params.set('qcLineId', updates.qcLineId)
        else params.delete('qcLineId')
      }
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  // ─────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────

  const poListQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 60_000 })
  const poQuery = usePurchaseOrder(selectedPoId)
  const receiptQuery = useReceipt(receiptIdForQc)
  const recentReceiptsQuery = useReceiptsList({ limit: 20 }, { staleTime: 30_000 })
  const putawayQuery = usePutaway(putawayId)
  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)
  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

  const qcLines = useMemo(() => receiptQuery.data?.lines ?? [], [receiptQuery.data?.lines])

  const activeQcLineId = useMemo(() => {
    if (qcLines.length === 0) return ''
    const hasSelected = qcLines.some((line) => line.id === selectedQcLineId)
    if (!selectedQcLineId || !hasSelected) {
      const nextLine = qcLines.find((line) => getQcBreakdown(line).remaining > 0) ?? qcLines[0]
      return nextLine?.id ?? ''
    }
    return selectedQcLineId
  }, [qcLines, selectedQcLineId])

  const selectedQcLine = useMemo(() => {
    if (!activeQcLineId) return undefined
    return qcLines.find((line) => line.id === activeQcLineId)
  }, [activeQcLineId, qcLines])

  const qcEventsQuery = useQcEventsForLine(activeQcLineId, { staleTime: 30_000 })
  const qcEventsList = useMemo(() => qcEventsQuery.data?.data ?? [], [qcEventsQuery.data])

  // ─────────────────────────────────────────────────────────────
  // Derived Options
  // ─────────────────────────────────────────────────────────────

  const poOptions = useMemo<PurchaseOrderOption[]>(
    () =>
      (poListQuery.data?.data ?? [])
        .filter((po) => po.status !== 'received' && po.status !== 'closed' && po.status !== 'canceled')
        .map((po) => ({
          value: po.id,
          label: `${po.poNumber ?? po.id.slice(0, 8)} (${po.status})`,
          keywords: `${po.poNumber} ${po.id}`,
        })),
    [poListQuery.data],
  )

  const locationOptions = useMemo<LocationOption[]>(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

  const receiptLineOptions = useMemo<ReceiptLineOption[]>(() => {
    return (receiptQuery.data?.lines ?? []).map((line) => {
      const qc = line.qcSummary?.breakdown
      const acceptedQty = qc?.accept ?? 0
      const availableQty = line.availableForNewPutaway ?? line.remainingQuantityToPutaway ?? acceptedQty
      const holdQty = qc?.hold ?? 0
      const rejectQty = qc?.reject ?? 0
      const remainingQty = line.qcSummary?.remainingUninspectedQuantity ?? 0
      return {
        value: line.id,
        label: `Line ${line.id.slice(0, 8)}… — ${line.itemSku ?? line.itemId ?? 'Item'}${line.itemName ? ` — ${line.itemName}` : ''} · ${line.quantityReceived} ${line.uom}`,
        uom: line.uom,
        quantity: availableQty,
        acceptedQty,
        availableQty,
        holdQty,
        rejectQty,
        remainingQty,
        blockedReason: line.putawayBlockedReason ?? '',
        defaultToLocationId: line.defaultToLocationId ?? '',
        defaultFromLocationId: line.defaultFromLocationId ?? receiptQuery.data?.receivedToLocationId ?? '',
      }
    })
  }, [receiptQuery.data])

  // ─────────────────────────────────────────────────────────────
  // Resolved Values
  // ─────────────────────────────────────────────────────────────

  const resolvedReceiptLineInputs = useMemo(() => {
    if (receiptLineInputs) return receiptLineInputs
    if (!poQuery.data) return []
    return buildReceiptLines(poQuery.data)
  }, [receiptLineInputs, poQuery.data])

  const resolvedReceivedToLocationId = useMemo(() => {
    if (receivedToLocationId !== null) return receivedToLocationId
    return poQuery.data?.receivingLocationId ?? poQuery.data?.shipToLocationId ?? ''
  }, [poQuery.data, receivedToLocationId])

  const receiptLineSummary = useMemo<ReceiptLineSummary>(() => {
    const lines = resolvedReceiptLineInputs.map((line) => {
      const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
      const expectedQty = line.expectedQty ?? 0
      const delta = receivedQty - expectedQty
      const remaining = Math.max(0, expectedQty - receivedQty)
      return { ...line, receivedQty, expectedQty, delta, remaining }
    })
    const receivedLines = lines.filter((line) => line.receivedQty > 0)
    const discrepancyLines = lines.filter((line) => line.delta !== 0)
    const missingReasons = discrepancyLines.filter((line) => !line.discrepancyReason)
    const remainingLines = lines.filter((line) => line.remaining > 0)
    const totalExpected = lines.reduce((sum, line) => sum + line.expectedQty, 0)
    const totalReceived = lines.reduce((sum, line) => sum + line.receivedQty, 0)
    return { lines, receivedLines, discrepancyLines, missingReasons, remainingLines, totalExpected, totalReceived }
  }, [resolvedReceiptLineInputs])

  const receiptLines = useMemo(
    () => receiptQuery.data?.lines ?? [],
    [receiptQuery.data?.lines],
  )

  const receiptTotals = useMemo(() => {
    if (!receiptLines.length) {
      return {
        received: receiptLineSummary.totalReceived,
        accepted: 0,
        hold: 0,
        reject: 0,
        remaining: receiptLineSummary.lines.reduce((sum, line) => sum + (line.remaining ?? 0), 0),
      }
    }
    return receiptLines.reduce(
      (acc, line) => {
        acc.received += line.quantityReceived ?? 0
        const breakdown = line.qcSummary?.breakdown
        acc.accepted += breakdown?.accept ?? 0
        acc.hold += breakdown?.hold ?? 0
        acc.reject += breakdown?.reject ?? 0
        acc.remaining += line.qcSummary?.remainingUninspectedQuantity ?? 0
        return acc
      },
      { received: 0, accepted: 0, hold: 0, reject: 0, remaining: 0 },
    )
  }, [receiptLines, receiptLineSummary])

  // ─────────────────────────────────────────────────────────────
  // QC Derived Values
  // ─────────────────────────────────────────────────────────────

  const qcStats = selectedQcLine ? getQcBreakdown(selectedQcLine) : null
  const qcRemaining = qcStats?.remaining ?? 0

  const activeQcDraft = useMemo(() => {
    if (activeQcLineId && qcDraft.lineId === activeQcLineId) return qcDraft
    return { lineId: activeQcLineId, eventType: 'accept' as const, quantity: '' as const, reasonCode: '', notes: '' }
  }, [activeQcLineId, qcDraft])

  const qcEventType = activeQcDraft.eventType
  const qcReasonCode = qcEventType === 'accept' ? '' : activeQcDraft.reasonCode
  const qcNotes = qcEventType === 'accept' ? '' : activeQcDraft.notes

  const qcQuantity = useMemo(() => {
    if (!selectedQcLine || qcRemaining <= 0) return ''
    if (activeQcDraft.quantity === '' || activeQcDraft.quantity > qcRemaining) {
      return qcRemaining
    }
    return activeQcDraft.quantity
  }, [activeQcDraft.quantity, qcRemaining, selectedQcLine])

  const qcQuantityNumber = qcQuantity === '' ? 0 : Number(qcQuantity)
  const qcQuantityInvalid = !selectedQcLine || qcQuantityNumber <= 0 || qcQuantityNumber - qcRemaining > 1e-6
  const canRecordQc = !!selectedQcLine && qcRemaining > 0 && !qcQuantityInvalid

  // ─────────────────────────────────────────────────────────────
  // Workflow State
  // ─────────────────────────────────────────────────────────────

  const poStatus = poQuery.data?.status?.toLowerCase() ?? ''
  const poClosed = ['received', 'closed', 'canceled'].includes(poStatus)
  const receiptLoaded = !!receiptQuery.data
  const qcNeedsAttention = receiptLoaded
    ? receiptLines.some((line) => (line.qcSummary?.remainingUninspectedQuantity ?? 0) > 0)
    : true

  const putawayBlockingLine = receiptLines.find((line) => {
    const breakdown = line.qcSummary?.breakdown
    const hold = breakdown?.hold ?? 0
    const accept = breakdown?.accept ?? 0
    return hold > 0 && accept <= 0
  })

  const putawayHasAvailable = receiptLines.some((line) => {
    const available = line.availableForNewPutaway ?? line.remainingQuantityToPutaway ?? 0
    return available > 0
  })

  const putawayReady = !!receiptQuery.data && putawayHasAvailable && !putawayBlockingLine

  // ─────────────────────────────────────────────────────────────
  // Mutations
  // ─────────────────────────────────────────────────────────────

  const receiptMutation = useMutation({
    mutationFn: (payload: ReceiptCreatePayload) => createReceipt(payload),
    onSuccess: (receipt) => {
      setReceiptIdForQc(receipt.id)
      setPutawayLines([{ purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' }])
      void recentReceiptsQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: purchaseOrdersQueryKeys.all })
      if (selectedPoId) {
        void queryClient.invalidateQueries({ queryKey: purchaseOrdersQueryKeys.detail(selectedPoId) })
      }
      updateReceivingParams({ receiptId: receipt.id, putawayId: '' })
    },
  })

  const voidReceiptMutation = useMutation({
    mutationFn: (id: string) => voidReceiptApi(id),
    onSuccess: () => {
      void recentReceiptsQuery.refetch()
      if (receiptIdForQc) loadReceiptForQc('')
    },
  })

  const qcEventMutation = useMutation({
    mutationFn: (payload: QcEventCreatePayload) => createQcEvent(payload),
    onSuccess: (event) => {
      setLastQcEvent(event)
      updateQcDraft({ reasonCode: '', notes: '' })
      void queryClient.invalidateQueries({ queryKey: receivingQueryKeys.receipts.detail(receiptIdForQc) })
      void queryClient.invalidateQueries({ queryKey: receivingQueryKeys.qcEvents.forLine(activeQcLineId) })
      void recentReceiptsQuery.refetch()
    },
  })

  const putawayMutation = useMutation({
    mutationFn: (payload: PutawayCreatePayload) => createPutaway(payload),
    onSuccess: (p) => {
      setPutawayId(p.id)
      updateReceivingParams({ receiptId: receiptIdForQc, putawayId: p.id })
      void queryClient.invalidateQueries({ queryKey: receivingQueryKeys.receipts.detail(receiptIdForQc) })
      void recentReceiptsQuery.refetch()
    },
  })

  const postPutawayMutation = useMutation({
    mutationFn: (id: string) => postPutaway(id),
    onSuccess: (p) => {
      setPutawayId(p.id)
      setPutawayResumeNotice(null)
      void putawayQuery.refetch()
    },
    onError: (error) => {
      if (getErrorMessage(error, '') === 'Putaway already posted.') {
        void putawayQuery.refetch()
      }
    },
  })

  // ─────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────

  const handlePoChange = useCallback((nextId: string) => {
    setSelectedPoId(nextId)
    setReceiptLineInputs(null)
    setReceiptNotes('')
    setReceivedToLocationId(null)
    receiptMutation.reset()
  }, [receiptMutation])

  const loadReceiptForQc = useCallback((nextId: string) => {
    setReceiptIdForQc(nextId)
    setPutawayFillNotice(null)
    setPutawayResumeNotice(null)
    hydratedPutawayId.current = null
    if (nextId !== receiptIdForQc) {
      setPutawayId('')
      setPutawayLines([{ purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' }])
      updateReceivingParams({ receiptId: nextId, putawayId: '' })
    }
  }, [receiptIdForQc, updateReceivingParams])

  const resetReceiptLines = useCallback(() => setReceiptLineInputs(null), [])

  const updateReceiptLine = useCallback((lineId: string, patch: Partial<ReceiptLineInput>) => {
    setReceiptLineInputs((prev) => {
      const lines = prev ?? resolvedReceiptLineInputs
      return lines.map((line) => (line.purchaseOrderLineId === lineId ? { ...line, ...patch } : line))
    })
  }, [resolvedReceiptLineInputs])

  const updateQcDraft = useCallback((patch: Partial<QcDraft>) => {
    if (!activeQcLineId) return
    setQcDraft((prev) => {
      const base =
        prev.lineId === activeQcLineId
          ? prev
          : { lineId: activeQcLineId, eventType: 'accept' as const, quantity: '' as const, reasonCode: '', notes: '' }
      return { ...base, ...patch, lineId: activeQcLineId }
    })
  }, [activeQcLineId])

  const addPutawayLine = useCallback(() => {
    setPutawayLines((prev) => [
      ...prev,
      { purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' },
    ])
  }, [])

  const resolvePutawayDefaults = useCallback(
    (opts: { defaultFromLocationId?: string; defaultToLocationId?: string }) => {
      const fromId = opts.defaultFromLocationId ?? ''
      const toId = opts.defaultToLocationId ?? ''
      return { fromId, toId: toId && toId === fromId ? '' : toId }
    },
    [],
  )

  const updatePutawayLine = useCallback(
    (idx: number, patch: Partial<PutawayLineInput>) => {
      setPutawayLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)))
    },
    [],
  )

  const fillPutawayFromReceipt = useCallback(() => {
    const lines = receiptQuery.data?.lines ?? []
    if (!lines.length) return
    const plannedLines = lines
      .map((l) => {
        const acceptedQty = l.qcSummary?.breakdown?.accept ?? 0
        const availableQty = l.availableForNewPutaway ?? l.remainingQuantityToPutaway ?? acceptedQty
        if (availableQty <= 0) return null
        const defaults = resolvePutawayDefaults({
          defaultFromLocationId: l.defaultFromLocationId ?? receiptQuery.data?.receivedToLocationId ?? '',
          defaultToLocationId: l.defaultToLocationId ?? '',
        })
        return {
          purchaseOrderReceiptLineId: l.id,
          toLocationId: defaults.toId,
          fromLocationId: defaults.fromId,
          uom: l.uom,
          quantity: availableQty,
        }
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line))

    if (!plannedLines.length) {
      const hasAccepted = lines.some((l) => (l.qcSummary?.breakdown?.accept ?? 0) > 0)
      const hasPending = lines.some((l) => {
        const remaining = l.remainingQuantityToPutaway ?? 0
        const available = l.availableForNewPutaway ?? l.remainingQuantityToPutaway ?? 0
        return remaining > 0 && available <= 0
      })
      if (!hasAccepted) {
        setPutawayFillNotice('No accepted quantity yet. Record QC acceptance to enable putaway.')
      } else if (hasPending) {
        setPutawayFillNotice('All accepted quantities are already planned in a putaway draft. Post or delete that draft to plan more.')
      } else {
        setPutawayFillNotice('No available quantity left to put away.')
      }
      return
    }
    setPutawayFillNotice(null)
    setPutawayLines(plannedLines)
  }, [receiptQuery.data, resolvePutawayDefaults])

  // ─────────────────────────────────────────────────────────────
  // Form Handlers
  // ─────────────────────────────────────────────────────────────

  const onCreateReceipt = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      receiptMutation.reset()
      if (!selectedPoId) return
      if (receiptLineSummary.missingReasons.length > 0) return
      const lines = receiptLineSummary.receivedLines.map((l) => ({
        purchaseOrderLineId: l.purchaseOrderLineId,
        uom: l.uom,
        quantityReceived: Number(l.receivedQty),
        discrepancyReason: l.discrepancyReason || undefined,
        discrepancyNotes: l.discrepancyNotes || undefined,
      }))
      if (lines.length === 0) return
      const discrepancyNote = receiptLineSummary.discrepancyLines.length
        ? `Discrepancies: ${receiptLineSummary.discrepancyLines
            .map((line) => {
              const reason = DISCREPANCY_LABELS[line.discrepancyReason] ?? 'Variance'
              const deltaValue = line.delta < 0 ? Math.abs(line.delta) : line.delta
              const notes = line.discrepancyNotes ? ` (${line.discrepancyNotes})` : ''
              return `${line.itemLabel} ${reason} ${deltaValue}${notes}`
            })
            .join('; ')}`
        : ''
      const composedNotes = [receiptNotes.trim(), discrepancyNote].filter((val) => val).join('\n')

      const payload = {
        purchaseOrderId: selectedPoId,
        receivedAt: new Date().toISOString(),
        receivedToLocationId: resolvedReceivedToLocationId || undefined,
        notes: composedNotes || undefined,
        lines,
      }

      // Queue operation when offline
      if (!isOnline) {
        await queueOperation({ type: 'receipt-create', payload })
        // Show optimistic feedback - set a pending receipt ID
        setReceiptIdForQc('pending-' + Date.now())
        return
      }

      receiptMutation.mutate(payload)
    },
    [selectedPoId, receiptLineSummary, receiptNotes, resolvedReceivedToLocationId, receiptMutation, isOnline, queueOperation],
  )

  const onCreateQcEvent = useCallback(async () => {
    if (!selectedQcLine) return
    if (qcQuantityInvalid) return
    qcEventMutation.reset()
    setLastQcEvent(null)

    const payload = {
      purchaseOrderReceiptLineId: selectedQcLine.id,
      eventType: qcEventType,
      quantity: qcQuantityNumber,
      uom: selectedQcLine.uom,
      reasonCode: qcReasonCode.trim() ? qcReasonCode.trim() : undefined,
      notes: qcNotes.trim() ? qcNotes.trim() : undefined,
      actorType: 'user' as const,
      actorId: user?.id ?? user?.email ?? undefined,
    }

    // Queue operation when offline
    if (!isOnline) {
      await queueOperation({ type: 'qc-event', payload })
      // Optimistically update local state
      setLastQcEvent({ ...payload, id: 'pending-' + Date.now(), occurredAt: new Date().toISOString() } as QcEvent)
      updateQcDraft({ reasonCode: '', notes: '' })
      return
    }

    qcEventMutation.mutate(payload)
  }, [selectedQcLine, qcQuantityInvalid, qcEventType, qcQuantityNumber, qcReasonCode, qcNotes, user, qcEventMutation, isOnline, queueOperation, updateQcDraft])

  const onCreatePutaway = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const lines = putawayLines
        .filter((l) => l.purchaseOrderReceiptLineId && l.toLocationId && l.uom && l.quantity !== '' && Number(l.quantity) > 0)
        .map((l, idx) => {
          const selected = receiptLineOptions.find((opt) => opt.value === l.purchaseOrderReceiptLineId)
          const fallbackFrom = l.fromLocationId || selected?.defaultFromLocationId || ''
          return {
            lineNumber: idx + 1,
            purchaseOrderReceiptLineId: l.purchaseOrderReceiptLineId,
            toLocationId: l.toLocationId,
            fromLocationId: fallbackFrom || undefined,
            uom: l.uom,
            quantity: Number(l.quantity),
          }
        })
      if (!receiptIdForQc || lines.length === 0) return

      const payload = {
        sourceType: 'purchase_order_receipt' as const,
        purchaseOrderReceiptId: receiptIdForQc,
        lines,
      }

      putawayMutation.reset()

      // Queue operation when offline
      if (!isOnline) {
        await queueOperation({ type: 'putaway-create', payload })
        // Show optimistic feedback
        setPutawayId('pending-' + Date.now())
        return
      }

      putawayMutation.mutate(payload)
    },
    [putawayLines, receiptLineOptions, receiptIdForQc, putawayMutation, isOnline, queueOperation],
  )

  // ─────────────────────────────────────────────────────────────
  // Bulk Operations Handlers (Basic)
  // ─────────────────────────────────────────────────────────────

  const toggleReceiptSelection = useCallback((receiptId: string) => {
    setSelectedReceiptIds((prev) => {
      const next = new Set(prev)
      if (next.has(receiptId)) {
        next.delete(receiptId)
      } else {
        next.add(receiptId)
      }
      return next
    })
  }, [])

  const toggleQcLineSelection = useCallback((lineId: string) => {
    setSelectedQcLineIds((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) {
        next.delete(lineId)
      } else {
        next.add(lineId)
      }
      return next
    })
  }, [])

  const clearReceiptSelection = useCallback(() => {
    setSelectedReceiptIds(new Set())
  }, [])

  const clearQcLineSelection = useCallback(() => {
    setSelectedQcLineIds(new Set())
  }, [])

  const bulkAcceptQcLines = useCallback(async () => {
    if (selectedQcLineIds.size === 0 || !receiptQuery.data) return
    
    setIsBulkProcessing(true)
    try {
      const selectedLines = receiptQuery.data.lines?.filter((line) => selectedQcLineIds.has(line.id)) ?? []
      
      for (const line of selectedLines) {
        const remaining = line.qcSummary?.remainingUninspectedQuantity ?? 0
        if (remaining > 0) {
          await createQcEvent({
            purchaseOrderReceiptLineId: line.id,
            eventType: 'accept',
            quantity: remaining,
            uom: line.uom,
            actorType: 'user',
            actorId: user?.id ?? user?.email ?? undefined,
          })
        }
      }
      
      // Refresh receipt data
      await queryClient.invalidateQueries({ queryKey: receivingQueryKeys.receipts.detail(receiptIdForQc) })
      clearQcLineSelection()
    } catch (error) {
      console.error('Bulk accept failed:', error)
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedQcLineIds, receiptQuery.data, receiptIdForQc, user, queryClient, clearQcLineSelection])

  const bulkHoldQcLines = useCallback(async (reasonCode: string, notes: string) => {
    if (selectedQcLineIds.size === 0 || !receiptQuery.data) return
    
    setIsBulkProcessing(true)
    try {
      const selectedLines = receiptQuery.data.lines?.filter((line) => selectedQcLineIds.has(line.id)) ?? []
      
      for (const line of selectedLines) {
        const remaining = line.qcSummary?.remainingUninspectedQuantity ?? 0
        if (remaining > 0) {
          await createQcEvent({
            purchaseOrderReceiptLineId: line.id,
            eventType: 'hold',
            quantity: remaining,
            uom: line.uom,
            reasonCode: reasonCode.trim() || undefined,
            notes: notes.trim() || undefined,
            actorType: 'user',
            actorId: user?.id ?? user?.email ?? undefined,
          })
        }
      }
      
      // Refresh receipt data
      await queryClient.invalidateQueries({ queryKey: receivingQueryKeys.receipts.detail(receiptIdForQc) })
      clearQcLineSelection()
    } catch (error) {
      console.error('Bulk hold failed:', error)
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedQcLineIds, receiptQuery.data, receiptIdForQc, user, queryClient, clearQcLineSelection])

  const bulkRejectQcLines = useCallback(async (reasonCode: string, notes: string) => {
    if (selectedQcLineIds.size === 0 || !receiptQuery.data) return
    
    setIsBulkProcessing(true)
    try {
      const selectedLines = receiptQuery.data.lines?.filter((line) => selectedQcLineIds.has(line.id)) ?? []
      
      for (const line of selectedLines) {
        const remaining = line.qcSummary?.remainingUninspectedQuantity ?? 0
        if (remaining > 0) {
          await createQcEvent({
            purchaseOrderReceiptLineId: line.id,
            eventType: 'reject',
            quantity: remaining,
            uom: line.uom,
            reasonCode: reasonCode.trim() || undefined,
            notes: notes.trim() || undefined,
            actorType: 'user',
            actorId: user?.id ?? user?.email ?? undefined,
          })
        }
      }
      
      // Refresh receipt data
      await queryClient.invalidateQueries({ queryKey: receivingQueryKeys.receipts.detail(receiptIdForQc) })
      clearQcLineSelection()
    } catch (error) {
      console.error('Bulk reject failed:', error)
    } finally {
      setIsBulkProcessing(false)
    }
  }, [selectedQcLineIds, receiptQuery.data, receiptIdForQc, user, queryClient, clearQcLineSelection])

  // ─────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────

  const receiptPostedForSelectedPo = receiptMutation.isSuccess && receiptMutation.data?.purchaseOrderId === selectedPoId

  const canPostReceipt =
    !!selectedPoId &&
    receiptLineSummary.receivedLines.length > 0 &&
    receiptLineSummary.missingReasons.length === 0 &&
    !receiptMutation.isPending &&
    !receiptPostedForSelectedPo &&
    !poClosed

  const putawayQcIssues = useMemo(
    () =>
      putawayLines
        .map((line, idx) => {
          if (!line.purchaseOrderReceiptLineId) return null
          const selected = receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)
          if (!selected) return null
          if ((selected.availableQty ?? 0) > 0) return null
          return { idx, label: selected.label, reason: selected.blockedReason }
        })
        .filter((x): x is { idx: number; label: string; reason: string } => x !== null),
    [putawayLines, receiptLineOptions],
  )

  const putawayQuantityIssues = useMemo(
    () =>
      putawayLines
        .map((line, idx) => {
          if (!line.purchaseOrderReceiptLineId) return null
          const selected = receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)
          if (!selected) return null
          const availableQty = selected.availableQty ?? 0
          const lineQty = line.quantity === '' ? 0 : Number(line.quantity)
          if (availableQty > 0 && lineQty <= availableQty) return null
          if (availableQty === 0) return null
          return { idx, label: selected.label, availableQty }
        })
        .filter((x): x is { idx: number; label: string; availableQty: number } => x !== null),
    [putawayLines, receiptLineOptions],
  )

  const canCreatePutaway = !putawayMutation.isPending && putawayQcIssues.length === 0 && putawayQuantityIssues.length === 0

  // ─────────────────────────────────────────────────────────────
  // Workflow Step Calculation
  // ─────────────────────────────────────────────────────────────

  const currentStep: WorkflowStep = !receiptPostedForSelectedPo
    ? 'receipt'
    : !receiptLoaded || qcNeedsAttention
      ? 'qc'
      : 'putaway'

  const stepper = useMemo<StepperState[]>(() => [
    {
      key: 'receipt',
      label: 'Confirm receipt',
      complete: receiptPostedForSelectedPo,
      blocked: poClosed ? 'PO closed' : receiptLineSummary.missingReasons.length > 0 ? 'Missing reasons' : null,
    },
    {
      key: 'qc',
      label: 'QC classification',
      complete: !!receiptQuery.data && !qcNeedsAttention,
      blocked: !receiptQuery.data ? 'Load receipt' : null,
    },
    {
      key: 'putaway',
      label: 'Putaway',
      complete: putawayQuery.data?.status === 'completed' || postPutawayMutation.isSuccess,
      blocked: putawayBlockingLine ? 'Hold blocks putaway' : !putawayHasAvailable ? 'Nothing available' : null,
    },
  ], [
    receiptPostedForSelectedPo,
    poClosed,
    receiptLineSummary.missingReasons.length,
    receiptQuery.data,
    qcNeedsAttention,
    putawayQuery.data?.status,
    postPutawayMutation.isSuccess,
    putawayBlockingLine,
    putawayHasAvailable,
  ])

  // ─────────────────────────────────────────────────────────────
  // Effects
  // ─────────────────────────────────────────────────────────────

  // Sync URL -> state for receiptId
  useEffect(() => {
    if (receiptIdFromQuery && receiptIdFromQuery !== receiptIdForQc) {
      loadReceiptForQc(receiptIdFromQuery)
    }
  }, [receiptIdFromQuery, receiptIdForQc, loadReceiptForQc])

  // Sync URL -> state for putawayId
  useEffect(() => {
    if (putawayIdFromQuery && putawayIdFromQuery !== putawayId) {
      setPutawayId(putawayIdFromQuery)
    }
  }, [putawayIdFromQuery, putawayId])

  // Load draft putaway from receipt
  useEffect(() => {
    const draftId = receiptQuery.data?.draftPutawayId ?? ''
    if (draftId && draftId !== putawayId) {
      setPutawayId(draftId)
      updateReceivingParams({ receiptId: receiptIdForQc, putawayId: draftId })
    }
  }, [receiptQuery.data?.draftPutawayId, receiptIdForQc, putawayId, updateReceivingParams])

  // Hydrate putaway lines from existing draft
  useEffect(() => {
    const putaway = putawayQuery.data
    if (!putaway) return
    if (!['draft', 'in_progress'].includes(putaway.status)) return
    if (hydratedPutawayId.current === putaway.id) return
    if (putaway.purchaseOrderReceiptId && putaway.purchaseOrderReceiptId !== receiptIdForQc) return
    const isEmpty = putawayLines.every(
      (line) => !line.purchaseOrderReceiptLineId && (line.quantity === '' || line.quantity === 0),
    )
    if (!isEmpty) return
    setPutawayLines(
      putaway.lines.map((line) => ({
        purchaseOrderReceiptLineId: line.purchaseOrderReceiptLineId,
        toLocationId: line.toLocationId,
        fromLocationId: line.fromLocationId,
        uom: line.uom,
        quantity: line.quantityPlanned,
      })),
    )
    setPutawayResumeNotice(`Draft ${putaway.id.slice(0, 8)}… loaded. Review lines, then post.`)
    hydratedPutawayId.current = putaway.id
  }, [putawayQuery.data, putawayLines, receiptIdForQc])

  // Auto-advance to next QC line
  useEffect(() => {
    if (!receiptQuery.data?.lines?.length) return
    if (!selectedQcLine) return
    const remaining = selectedQcLine.qcSummary?.remainingUninspectedQuantity ?? 0
    if (remaining > 0) return
    const nextLine = receiptQuery.data.lines.find(
      (line) => (line.qcSummary?.remainingUninspectedQuantity ?? 0) > 0,
    )
    if (nextLine && nextLine.id !== selectedQcLine.id) {
      setSelectedQcLineId(nextLine.id)
    }
  }, [receiptQuery.data?.lines, selectedQcLine, lastQcEvent?.id])

  // ─────────────────────────────────────────────────────────────
  // Filtering Logic
  // ─────────────────────────────────────────────────────────────

  const filteredReceipts = useMemo(() => {
    const receipts = recentReceiptsQuery.data?.data ?? []
    
    return receipts.filter((receipt: PurchaseOrderReceipt) => {
      // Search term filter
      if (receivingFilters.searchTerm) {
        const term = receivingFilters.searchTerm.toLowerCase()
        const matchesReceiptId = receipt.id.toLowerCase().includes(term)
        // Note: Supplier and PO number filtering would require joined data
        if (!matchesReceiptId) {
          return false
        }
      }

      // Supplier filter - would require joined data, skip for now
      // Location filter - would require joined data, skip for now

      // Date range filter
      if (receivingFilters.dateRange !== 'all' && receipt.receivedAt) {
        const receiptDate = new Date(receipt.receivedAt)
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        switch (receivingFilters.dateRange) {
          case 'today':
            if (receiptDate < today) return false
            break
          case 'week': {
            const weekAgo = new Date(today)
            weekAgo.setDate(weekAgo.getDate() - 7)
            if (receiptDate < weekAgo) return false
            break
          }
          case 'month': {
            const monthAgo = new Date(today)
            monthAgo.setMonth(monthAgo.getMonth() - 1)
            if (receiptDate < monthAgo) return false
            break
          }
          case 'custom':
            if (receivingFilters.dateFrom) {
              const fromDate = new Date(receivingFilters.dateFrom)
              if (receiptDate < fromDate) return false
            }
            if (receivingFilters.dateTo) {
              const toDate = new Date(receivingFilters.dateTo)
              toDate.setHours(23, 59, 59, 999)
              if (receiptDate > toDate) return false
            }
            break
        }
      }

      // Discrepancies filter (simplified - would need joined data)
      // Skip this filter for now as it requires PO line comparison

      return true
    })
  }, [recentReceiptsQuery.data, receivingFilters])

  const filteredReceiptLines = useMemo(() => {
    if (!receiptQuery.data?.lines) return []

    return receiptQuery.data.lines.filter((line) => {
      // Search term filter - simplified since item data not directly on line
      if (receivingFilters.searchTerm) {
        const term = receivingFilters.searchTerm.toLowerCase()
        const matchesLineId = line.id.toLowerCase().includes(term)
        if (!matchesLineId) {
          return false
        }
      }

      // QC Status filter
      if (receivingFilters.qcStatus !== 'all') {
        const qcSummary = line.qcSummary
        const remaining = qcSummary?.remainingUninspectedQuantity ?? 0

        switch (receivingFilters.qcStatus) {
          case 'pending':
            if (remaining === 0) return false
            break
          case 'accepted':
            if ((qcSummary?.breakdown?.accept ?? 0) === 0) return false
            break
          case 'hold':
            if ((qcSummary?.breakdown?.hold ?? 0) === 0) return false
            break
          case 'rejected':
            if ((qcSummary?.breakdown?.reject ?? 0) === 0) return false
            break
        }
      }

      // Priority filter
      if (receivingFilters.hasPriority) {
        // Consider lines with hold or rejected quantities as priority
        const qcSummary = line.qcSummary
        const hasIssues = (qcSummary?.breakdown?.hold ?? 0) > 0 || (qcSummary?.breakdown?.reject ?? 0) > 0
        if (!hasIssues) return false
      }

      return true
    })
  }, [receiptQuery.data, receivingFilters])

  // ─────────────────────────────────────────────────────────────
  // Bulk Operations Handlers (Dependent on Filtered Data)
  // ─────────────────────────────────────────────────────────────

  const selectAllReceipts = useCallback(() => {
    const allIds = filteredReceipts.map((r) => r.id)
    setSelectedReceiptIds(new Set(allIds))
  }, [filteredReceipts])

  const selectAllQcLines = useCallback(() => {
    const allIds = filteredReceiptLines.map((line) => line.id)
    setSelectedQcLineIds(new Set(allIds))
  }, [filteredReceiptLines])

  // ─────────────────────────────────────────────────────────────
  // Context Value
  // ─────────────────────────────────────────────────────────────

  const value = useMemo<ReceivingContextValue>(
    () => ({
      // URL Params
      searchParams,
      updateReceivingParams,

      // Receipt Step
      selectedPoId,
      setSelectedPoId,
      handlePoChange,
      receiptLineInputs: resolvedReceiptLineInputs,
      setReceiptLineInputs,
      updateReceiptLine,
      resetReceiptLines,
      receiptNotes,
      setReceiptNotes,
      receivedToLocationId,
      setReceivedToLocationId,
      resolvedReceivedToLocationId,
      receiptLineSummary,

      // Receipt Queries
      poListQuery,
      poQuery,
      poOptions,
      poClosed,

      // Receipt Mutations
      receiptMutation,
      voidReceiptMutation,
      onCreateReceipt,
      canPostReceipt,
      receiptPostedForSelectedPo,

      // QC Step
      receiptIdForQc,
      setReceiptIdForQc,
      loadReceiptForQc,
      selectedQcLineId,
      setSelectedQcLineId,
      activeQcLineId,
      selectedQcLine,
      qcDraft,
      updateQcDraft,
      lastQcEvent,
      setLastQcEvent,
      qcLines,
      qcStats,
      qcRemaining,
      qcEventType,
      qcQuantity,
      qcReasonCode,
      qcNotes,
      qcQuantityInvalid,
      canRecordQc,

      // QC Queries
      receiptQuery,
      qcEventsQuery,
      qcEventsList,
      recentReceiptsQuery,

      // QC Mutations
      qcEventMutation,
      onCreateQcEvent,

      // Putaway Step
      putawayLines,
      setPutawayLines,
      addPutawayLine,
      updatePutawayLine,
      fillPutawayFromReceipt,
      resolvePutawayDefaults,
      putawayId,
      setPutawayId,
      putawayFillNotice,
      setPutawayFillNotice,
      putawayResumeNotice,
      receiptLineOptions,
      putawayQcIssues,
      putawayQuantityIssues,
      canCreatePutaway,

      // Putaway Queries
      putawayQuery,
      locationsQuery,
      locationOptions,
      locationSearch,
      setLocationSearch,

      // Putaway Mutations
      putawayMutation,
      postPutawayMutation,
      onCreatePutaway,

      // Workflow
      currentStep,
      stepper,
      receiptLoaded,
      qcNeedsAttention,
      putawayBlockingLine,
      putawayHasAvailable,
      putawayReady,
      receiptTotals,

      // Search and Filters
      receivingFilters,
      setReceivingFilters,
      filteredReceipts,
      filteredReceiptLines,

      // Bulk Operations
      selectedReceiptIds,
      selectedQcLineIds,
      toggleReceiptSelection,
      toggleQcLineSelection,
      selectAllReceipts,
      selectAllQcLines,
      clearReceiptSelection,
      clearQcLineSelection,
      bulkAcceptQcLines,
      bulkHoldQcLines,
      bulkRejectQcLines,
      isBulkProcessing,

      // Utilities
      getErrorMessage,
      mapErrorMessage,

      // Offline Support
      isOnline,
      pendingCount,
      pendingOperations,
      isSyncing,
      syncPendingOperations,
      clearOfflineQueue,
    }),
    [
      searchParams,
      updateReceivingParams,
      selectedPoId,
      handlePoChange,
      resolvedReceiptLineInputs,
      updateReceiptLine,
      resetReceiptLines,
      receiptNotes,
      receivedToLocationId,
      resolvedReceivedToLocationId,
      receiptLineSummary,
      poListQuery,
      poQuery,
      poOptions,
      poClosed,
      receiptMutation,
      voidReceiptMutation,
      onCreateReceipt,
      canPostReceipt,
      receiptPostedForSelectedPo,
      receiptIdForQc,
      loadReceiptForQc,
      selectedQcLineId,
      activeQcLineId,
      selectedQcLine,
      qcDraft,
      updateQcDraft,
      lastQcEvent,
      qcLines,
      qcStats,
      qcRemaining,
      qcEventType,
      qcQuantity,
      qcReasonCode,
      qcNotes,
      qcQuantityInvalid,
      canRecordQc,
      receiptQuery,
      qcEventsQuery,
      qcEventsList,
      recentReceiptsQuery,
      qcEventMutation,
      onCreateQcEvent,
      putawayLines,
      addPutawayLine,
      updatePutawayLine,
      fillPutawayFromReceipt,
      resolvePutawayDefaults,
      putawayId,
      putawayFillNotice,
      putawayResumeNotice,
      receiptLineOptions,
      putawayQcIssues,
      putawayQuantityIssues,
      canCreatePutaway,
      putawayQuery,
      locationsQuery,
      locationOptions,
      locationSearch,
      putawayMutation,
      postPutawayMutation,
      onCreatePutaway,
      currentStep,
      stepper,
      receiptLoaded,
      qcNeedsAttention,
      putawayBlockingLine,
      putawayHasAvailable,
      putawayReady,
      receiptTotals,
      receivingFilters,
      filteredReceipts,
      filteredReceiptLines,
      selectedReceiptIds,
      selectedQcLineIds,
      toggleReceiptSelection,
      toggleQcLineSelection,
      selectAllReceipts,
      selectAllQcLines,
      clearReceiptSelection,
      clearQcLineSelection,
      bulkAcceptQcLines,
      bulkHoldQcLines,
      bulkRejectQcLines,
      isBulkProcessing,
      getErrorMessage,
      mapErrorMessage,
      isOnline,
      pendingCount,
      pendingOperations,
      isSyncing,
      syncPendingOperations,
      clearOfflineQueue,
    ],
  )

  return <ReceivingContext.Provider value={value}>{children}</ReceivingContext.Provider>
}
