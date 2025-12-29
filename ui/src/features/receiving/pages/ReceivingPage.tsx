import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createReceipt, type ReceiptCreatePayload, voidReceiptApi } from '../api/receipts'
import { createPutaway, postPutaway, type PutawayCreatePayload } from '../api/putaways'
import { createQcEvent, type QcEventCreatePayload } from '../api/qc'
import type { ApiError, QcEvent } from '@api/types'
import { Alert, Badge, Button, Card, Combobox, Input, LoadingSpinner, Section, Textarea } from '@shared/ui'
import { useAuth } from '@shared/auth'
import { useDebouncedValue } from '@shared'
import { formatNumber } from '@shared/formatters'
import { useLocationsList } from '@features/locations/queries'
import { purchaseOrdersQueryKeys, usePurchaseOrder, usePurchaseOrdersList } from '@features/purchaseOrders/queries'
import { receivingQueryKeys, usePutaway, useQcEventsForLine, useReceipt, useReceiptsList } from '../queries'
import { ReceiptLinesTable } from '../components/ReceiptLinesTable'
import { ReceiptSummaryPanel } from '../components/ReceiptSummaryPanel'
import { RecentReceiptsTable } from '../components/RecentReceiptsTable'
import { QcLinesTable } from '../components/QcLinesTable'
import { QcDetailPanel } from '../components/QcDetailPanel'
import { PutawayLinesEditor } from '../components/PutawayLinesEditor'
import { PutawaySummaryTable } from '../components/PutawaySummaryTable'
import type { PutawayLineInput, QcDraft, ReceiptLineInput, ReceiptLineOption, ReceiptLineSummary } from '../types'
import { buildReceiptLines, getQcBreakdown } from '../utils'

export default function ReceivingPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const poIdFromQuery = searchParams.get('poId') ?? ''
  const receiptIdFromQuery = searchParams.get('receiptId') ?? ''
  const putawayIdFromQuery = searchParams.get('putawayId') ?? ''
  const qcLineIdFromQuery = searchParams.get('qcLineId') ?? ''
  const [selectedPoId, setSelectedPoId] = useState(() => poIdFromQuery)
  const [receiptLineInputs, setReceiptLineInputs] = useState<ReceiptLineInput[] | null>(null)
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receivedToLocationId, setReceivedToLocationId] = useState<string | null>(null)
  const [receiptIdForPutaway, setReceiptIdForPutaway] = useState(() => receiptIdFromQuery)
  const [selectedQcLineId, setSelectedQcLineId] = useState(() => qcLineIdFromQuery)
  const [qcDraft, setQcDraft] = useState<QcDraft>({
    lineId: '',
    eventType: 'accept',
    quantity: '',
    reasonCode: '',
    notes: '',
  })
  const [lastQcEvent, setLastQcEvent] = useState<QcEvent | null>(null)
  const [putawayFillNotice, setPutawayFillNotice] = useState<string | null>(null)
  const [putawayResumeNotice, setPutawayResumeNotice] = useState<string | null>(null)
  const [putawayLines, setPutawayLines] = useState<PutawayLineInput[]>([
    { purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' },
  ])
  const [locationSearch, setLocationSearch] = useState('')
  const [putawayId, setPutawayId] = useState(() => putawayIdFromQuery)
  const hydratedPutawayId = useRef<string | null>(null)
  const receiptFormRef = useRef<HTMLFormElement | null>(null)
  const qcSectionRef = useRef<HTMLDivElement | null>(null)
  const putawayFormRef = useRef<HTMLFormElement | null>(null)
  const previousStepRef = useRef<'receipt' | 'qc' | 'putaway' | null>(null)
  const workflowRailRef = useRef<HTMLElement | null>(null)
  const hasUserScrolledRef = useRef(false)
  const allowAutoScrollRef = useRef(false)
  const [isWorkflowSticky, setIsWorkflowSticky] = useState(false)
  const poListQuery = usePurchaseOrdersList({ limit: 200 }, { staleTime: 60_000 })

  const poQuery = usePurchaseOrder(selectedPoId)

  useEffect(() => {
    const handleScroll = () => {
      if (!hasUserScrolledRef.current) {
        if (window.scrollY <= 0) return
        hasUserScrolledRef.current = true
      }
      const node = workflowRailRef.current
      if (!node) return
      const top = node.getBoundingClientRect().top
      setIsWorkflowSticky(top <= 16)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [])

  const updateReceivingParams = (updates: { receiptId?: string; putawayId?: string }) => {
    const params = new URLSearchParams(searchParams)
    if (updates.receiptId !== undefined) {
      if (updates.receiptId) {
        params.set('receiptId', updates.receiptId)
      } else {
        params.delete('receiptId')
      }
    }
    if (updates.putawayId !== undefined) {
      if (updates.putawayId) {
        params.set('putawayId', updates.putawayId)
      } else {
        params.delete('putawayId')
      }
    }
    setSearchParams(params, { replace: true })
  }

  const discrepancyLabels: Record<ReceiptLineInput['discrepancyReason'], string> = {
    '': 'No variance',
    short: 'Short',
    over: 'Over',
    damaged: 'Damaged',
    substituted: 'Substituted',
  }

  const handlePoChange = (nextId: string) => {
    setSelectedPoId(nextId)
    setReceiptLineInputs(null)
    setReceiptNotes('')
    setReceivedToLocationId(null)
    receiptMutation.reset()
  }

  const resolvedReceiptLineInputs = useMemo(() => {
    if (receiptLineInputs) return receiptLineInputs
    if (!poQuery.data) return []
    return buildReceiptLines(poQuery.data)
  }, [receiptLineInputs, poQuery.data])

  const resolvedReceivedToLocationId = useMemo(() => {
    if (receivedToLocationId !== null) return receivedToLocationId
    return poQuery.data?.receivingLocationId ?? poQuery.data?.shipToLocationId ?? ''
  }, [poQuery.data, receivedToLocationId])

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (!error) return fallback
    if (typeof error === 'string') return error
    if (typeof error === 'object' && 'message' in (error as { message?: unknown })) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim().length > 0) return message
    }
    return fallback
  }

  const receiptErrorMap: Record<string, string> = {
    'Purchase order is already fully received/closed.':
      'This PO is already received/closed. Create a receipt on a different PO.',
    'Receipt line UOM must match the purchase order line UOM.':
      'Use the same UOM as the PO line for each receipt line.',
    'One or more purchase order lines were not found.':
      'One or more PO lines are invalid. Re-select the PO lines and try again.',
    'All receipt lines must reference the provided purchase order.':
      'Each receipt line must belong to the selected PO.',
    'Discrepancy reason is required when received quantity differs from expected.':
      'Select a discrepancy reason for each line that differs from expected.',
  }

  const putawayCreateErrorMap: Record<string, string> = {
    'Source and destination locations must differ.':
      'Pick a different To location than the From location for each line.',
    'Putaway line UOM must match the receipt line UOM.':
      'Use the same UOM as the receipt line.',
    'fromLocationId is required when the receipt lacks a staging location.':
      'Select a From location for each line (staging/receiving).',
    'QC hold or missing acceptance prevents planning this putaway.':
      'This receipt line is on QC hold or has no accepted quantity. Resolve QC before planning putaway.',
    'Requested quantity exceeds available putaway quantity.':
      'Reduce the quantity to the remaining available amount.',
    'purchaseOrderReceiptId is required for receipt-based putaways.':
      'Select a receipt before creating a putaway.',
    'One or more receipt lines were not found.':
      'One or more receipt lines are invalid. Reload the receipt and try again.',
    'Receipt is voided; putaway cannot be created.':
      'This receipt is voided. Putaway is locked.',
  }

  const putawayPostErrorMap: Record<string, string> = {
    'Putaway already posted.':
      'This putaway was already posted. No additional changes were made.',
    'Putaway line quantity must be greater than zero before posting.':
      'Each line must have a positive quantity before posting.',
    'Putaway has no lines to post.':
      'Add at least one line before posting.',
    'All putaway lines are already completed or canceled.':
      'Nothing left to post for this putaway.',
    'QC hold or missing acceptance prevents posting this putaway.':
      'QC hold is blocking posting. Resolve QC and try again.',
    'Putaway quantity exceeds available accepted quantity.':
      'Reduce quantities or record QC acceptance before posting.',
    'Requested putaway quantity exceeds accepted quantity.':
      'Reduce quantities or record QC acceptance before posting.',
    'Receipt is voided; putaway cannot be posted.':
      'This receipt is voided. Putaway is locked.',
  }

  const mapErrorMessage = (message: string, map: Record<string, string>) => {
    if (!message) return message
    if (map[message]) return map[message]
    if (message.startsWith('Requested quantity exceeds available putaway quantity')) {
      return 'Reduce the quantity to the remaining available amount.'
    }
    if (message.startsWith('Requested putaway quantity exceeds accepted quantity')) {
      return 'Reduce quantities or record QC acceptance before posting.'
    }
    return message
  }

  const receiptQuery = useReceipt(receiptIdForPutaway)

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

  const qcErrorMap: Record<string, string> = {
    'Receipt line not found.':
      'That receipt line could not be found. Reload the receipt and try again.',
    'QC event UOM must match the receipt line UOM.':
      'UOM mismatch. QC events must use the receipt line UOM.',
    'QC quantities cannot exceed the received quantity for the line.':
      'Quantity exceeds the remaining allocable quantity for this line.',
    'Referenced receipt line does not exist.':
      'That receipt line no longer exists. Reload the receipt and try again.',
    'QC quantity must be greater than zero.':
      'Enter a quantity greater than zero.',
    'Receipt line has no receiving location to post accepted inventory.':
      'Set a receiving/staging location on the PO before recording acceptance.',
    'Receipt is voided; QC events are not allowed.':
      'This receipt is voided. QC events are locked.',
  }

  const qcEventMutation = useMutation({
    mutationFn: (payload: QcEventCreatePayload) => createQcEvent(payload),
    onSuccess: (event) => {
      setLastQcEvent(event)
      updateQcDraft({ reasonCode: '', notes: '' })
      void queryClient.invalidateQueries({
        queryKey: receivingQueryKeys.receipts.detail(receiptIdForPutaway),
      })
      void queryClient.invalidateQueries({
        queryKey: receivingQueryKeys.qcEvents.forLine(activeQcLineId),
      })
      void recentReceiptsQuery.refetch()
    },
  })

  const receiptLineOptions = useMemo<ReceiptLineOption[]>(() => {
    return (receiptQuery.data?.lines ?? []).map((line) => {
      const qc = line.qcSummary?.breakdown
      const acceptedQty = qc?.accept ?? 0
      const availableQty =
        line.availableForNewPutaway ?? line.remainingQuantityToPutaway ?? acceptedQty
      const holdQty = qc?.hold ?? 0
      const rejectQty = qc?.reject ?? 0
      const remainingQty = line.qcSummary?.remainingUninspectedQuantity ?? 0
      const qcParts = [`Accept ${acceptedQty}`]
      if (holdQty > 0) qcParts.push(`Hold ${holdQty}`)
      if (rejectQty > 0) qcParts.push(`Reject ${rejectQty}`)
      if (remainingQty > 0) qcParts.push(`Uninspected ${remainingQty}`)
      qcParts.push(`Avail ${availableQty}`)
      return {
        value: line.id,
        label: `Line ${line.id.slice(0, 8)}… — ${line.itemSku ?? line.itemId ?? 'Item'}${line.itemName ? ` — ${line.itemName}` : ''} · ${line.quantityReceived} ${line.uom} · QC: ${qcParts.join(', ')}`,
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

  const putawayQuery = usePutaway(putawayId)

  const recentReceiptsQuery = useReceiptsList({ limit: 20 }, { staleTime: 30_000 })

  useEffect(() => {
    const draftId = receiptQuery.data?.draftPutawayId ?? ''
    if (draftId && draftId !== putawayId) {
      setPutawayId(draftId)
      updateReceivingParams({ receiptId: receiptIdForPutaway, putawayId: draftId })
    }
  }, [receiptQuery.data?.draftPutawayId, receiptIdForPutaway, putawayId])

  useEffect(() => {
    const putaway = putawayQuery.data
    if (!putaway) return
    if (!['draft', 'in_progress'].includes(putaway.status)) return
    if (hydratedPutawayId.current === putaway.id) return
    if (putaway.purchaseOrderReceiptId && putaway.purchaseOrderReceiptId !== receiptIdForPutaway) return
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
  }, [putawayQuery.data, putawayLines, receiptIdForPutaway])

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

  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)

  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

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
    return {
      lines,
      receivedLines,
      discrepancyLines,
      missingReasons,
      remainingLines,
      totalExpected,
      totalReceived,
    }
  }, [resolvedReceiptLineInputs])

  const receiptLines = receiptQuery.data?.lines ?? []
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

  const selectedLineTotals = useMemo(() => {
    if (!selectedQcLine) {
      return { received: 0, accepted: 0, hold: 0, reject: 0, remaining: 0 }
    }
    const breakdown = selectedQcLine.qcSummary?.breakdown
    return {
      received: selectedQcLine.quantityReceived ?? 0,
      accepted: breakdown?.accept ?? 0,
      hold: breakdown?.hold ?? 0,
      reject: breakdown?.reject ?? 0,
      remaining: selectedQcLine.qcSummary?.remainingUninspectedQuantity ?? 0,
    }
  }, [selectedQcLine])

  const updateReceiptIdForPutaway = (nextId: string) => {
    setReceiptIdForPutaway(nextId)
    setPutawayFillNotice(null)
    setPutawayResumeNotice(null)
    hydratedPutawayId.current = null
    if (nextId !== receiptIdForPutaway) {
      setPutawayId('')
      setPutawayLines([
        { purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' },
      ])
      updateReceivingParams({ receiptId: nextId, putawayId: '' })
    }
  }

  useEffect(() => {
    if (receiptIdFromQuery && receiptIdFromQuery !== receiptIdForPutaway) {
      updateReceiptIdForPutaway(receiptIdFromQuery)
    }
  }, [receiptIdFromQuery, receiptIdForPutaway])

  useEffect(() => {
    if (putawayIdFromQuery && putawayIdFromQuery !== putawayId) {
      setPutawayId(putawayIdFromQuery)
    }
  }, [putawayIdFromQuery, putawayId])

  const receiptMutation = useMutation({
    mutationFn: (payload: ReceiptCreatePayload) => createReceipt(payload),
    onSuccess: (receipt) => {
      updateReceiptIdForPutaway(receipt.id)
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
      if (receiptIdForPutaway) updateReceiptIdForPutaway('')
    },
  })

  const putawayMutation = useMutation({
    mutationFn: (payload: PutawayCreatePayload) => createPutaway(payload),
    onSuccess: (p) => {
      setPutawayId(p.id)
      updateReceivingParams({ receiptId: receiptIdForPutaway, putawayId: p.id })
      void queryClient.invalidateQueries({
        queryKey: receivingQueryKeys.receipts.detail(receiptIdForPutaway),
      })
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

  const resetReceiptLines = () => {
    setReceiptLineInputs(null)
  }

  const updateReceiptLine = (lineId: string, patch: Partial<ReceiptLineInput>) => {
    setReceiptLineInputs((prev) => {
      const lines = prev ?? resolvedReceiptLineInputs
      return lines.map((line) =>
        line.purchaseOrderLineId === lineId ? { ...line, ...patch } : line,
      )
    })
  }

  const updateQcDraft = (patch: Partial<QcDraft>) => {
    if (!activeQcLineId) return
    setQcDraft((prev) => {
      const base =
        prev.lineId === activeQcLineId
          ? prev
          : { lineId: activeQcLineId, eventType: 'accept', quantity: '', reasonCode: '', notes: '' }
      return { ...base, ...patch, lineId: activeQcLineId }
    })
  }

  const addPutawayLine = () =>
    setPutawayLines((prev) => [
      ...prev,
      { purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' },
    ])

  const resolvePutawayDefaults = (opts: { defaultFromLocationId?: string; defaultToLocationId?: string }) => {
    const fromId = opts.defaultFromLocationId ?? ''
    const toId = opts.defaultToLocationId ?? ''
    return {
      fromId,
      toId: toId && toId === fromId ? '' : toId,
    }
  }

  const fillPutawayFromReceipt = () => {
    const lines = receiptQuery.data?.lines ?? []
    if (!lines.length) return
    const plannedLines = lines
      .map((l) => {
        const acceptedQty = l.qcSummary?.breakdown?.accept ?? 0
        const availableQty =
          l.availableForNewPutaway ?? l.remainingQuantityToPutaway ?? acceptedQty
        if (availableQty <= 0) {
          return null
        }
        return {
          purchaseOrderReceiptLineId: l.id,
          ...(() => {
            const defaults = resolvePutawayDefaults({
              defaultFromLocationId: l.defaultFromLocationId ?? receiptQuery.data?.receivedToLocationId ?? '',
              defaultToLocationId: l.defaultToLocationId ?? '',
            })
            return { toLocationId: defaults.toId, fromLocationId: defaults.fromId }
          })(),
          uom: l.uom,
          quantity: availableQty,
        }
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line))

    if (!plannedLines.length) {
      const hasAccepted = lines.some((l) => (l.qcSummary?.breakdown?.accept ?? 0) > 0)
      const hasPending = lines.some((l) => {
        const remaining = l.remainingQuantityToPutaway ?? 0
        const available =
          l.availableForNewPutaway ?? l.remainingQuantityToPutaway ?? 0
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
  }

  const updatePutawayLine = (
    idx: number,
    patch: Partial<{
      purchaseOrderReceiptLineId: string
      toLocationId: string
      fromLocationId: string
      uom: string
      quantity: number | ''
    }>,
  ) => {
    setPutawayLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)))
  }

  const onCreateReceipt = (e: React.FormEvent) => {
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
            const reason = discrepancyLabels[line.discrepancyReason] ?? 'Variance'
            const deltaValue = line.delta < 0 ? Math.abs(line.delta) : line.delta
            const notes = line.discrepancyNotes ? ` (${line.discrepancyNotes})` : ''
            return `${line.itemLabel} ${reason} ${deltaValue}${notes}`
          })
          .join('; ')}`
      : ''
    const composedNotes = [receiptNotes.trim(), discrepancyNote].filter((val) => val).join('\n')
    allowAutoScrollRef.current = true
    receiptMutation.mutate({
      purchaseOrderId: selectedPoId,
      receivedAt: new Date().toISOString(),
      receivedToLocationId: resolvedReceivedToLocationId || undefined,
      notes: composedNotes || undefined,
      lines,
    })
  }

  const onCreateQcEvent = () => {
    if (!selectedQcLine) return
    if (qcQuantityInvalid) return
    qcEventMutation.reset()
    setLastQcEvent(null)
    allowAutoScrollRef.current = true
    qcEventMutation.mutate({
      purchaseOrderReceiptLineId: selectedQcLine.id,
      eventType: qcEventType,
      quantity: qcQuantityNumber,
      uom: selectedQcLine.uom,
      reasonCode: qcReasonCode.trim() ? qcReasonCode.trim() : undefined,
      notes: qcNotes.trim() ? qcNotes.trim() : undefined,
      actorType: 'user',
      actorId: user?.id ?? user?.email ?? undefined,
    })
  }

  const onCreatePutaway = (e: React.FormEvent) => {
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
    if (!receiptIdForPutaway || lines.length === 0) return
    putawayMutation.reset()
    allowAutoScrollRef.current = true
    putawayMutation.mutate({
      sourceType: 'purchase_order_receipt',
      purchaseOrderReceiptId: receiptIdForPutaway,
      lines,
    })
  }

  const poStatus = poQuery.data?.status?.toLowerCase() ?? ''
  const poClosed = ['received', 'closed', 'canceled'].includes(poStatus)
  const receiptPostedForSelectedPo =
    receiptMutation.isSuccess && receiptMutation.data?.purchaseOrderId === selectedPoId
  const canPostReceipt =
    !!selectedPoId &&
    receiptLineSummary.receivedLines.length > 0 &&
    receiptLineSummary.missingReasons.length === 0 &&
    !receiptMutation.isPending &&
    !receiptPostedForSelectedPo &&
    !poClosed
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
  const currentStep: 'receipt' | 'qc' | 'putaway' =
    !receiptPostedForSelectedPo ? 'receipt' : !receiptLoaded || qcNeedsAttention ? 'qc' : 'putaway'
  const stepper = [
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
  ]
  const activeQcDraft =
    activeQcLineId && qcDraft.lineId === activeQcLineId
      ? qcDraft
      : { lineId: activeQcLineId, eventType: 'accept', quantity: '', reasonCode: '', notes: '' }
  const qcEventType = activeQcDraft.eventType
  const selectedQcStats = selectedQcLine ? getQcBreakdown(selectedQcLine) : null
  const selectedPutawayAvailable =
    selectedQcLine?.availableForNewPutaway ?? selectedQcLine?.remainingQuantityToPutaway ?? 0
  const qcRemaining = selectedQcStats?.remaining ?? 0
  const qcQuantity = useMemo(() => {
    if (!selectedQcLine || qcRemaining <= 0) return ''
    if (activeQcDraft.quantity === '' || activeQcDraft.quantity > qcRemaining) {
      return qcRemaining
    }
    return activeQcDraft.quantity
  }, [activeQcDraft.quantity, qcRemaining, selectedQcLine])
  const qcReasonCode = qcEventType === 'accept' ? '' : activeQcDraft.reasonCode
  const qcNotes = qcEventType === 'accept' ? '' : activeQcDraft.notes
  const qcQuantityNumber = qcQuantity === '' ? 0 : Number(qcQuantity)
  const qcQuantityInvalid =
    !selectedQcLine || qcQuantityNumber <= 0 || qcQuantityNumber - qcRemaining > 1e-6
  const canRecordQc =
    !qcEventMutation.isPending &&
    !!selectedQcLine &&
    qcRemaining > 0 &&
    !qcQuantityInvalid
  const activeLastQcEvent =
    lastQcEvent?.purchaseOrderReceiptLineId === activeQcLineId ? lastQcEvent : null
  const qcEventsList = qcEventsQuery.data?.data ?? []
  const putawayQcIssues = putawayLines
    .map((line, idx) => {
      if (!line.purchaseOrderReceiptLineId) return null
      const selected = receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)
      if (!selected) return null
      if ((selected.availableQty ?? 0) > 0) return null
      return { idx, label: selected.label, reason: selected.blockedReason }
    })
    .filter(Boolean)
  const putawayQuantityIssues = putawayLines
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
    .filter(Boolean)
  const canCreatePutaway =
    !putawayMutation.isPending &&
    putawayQcIssues.length === 0 &&
    putawayQuantityIssues.length === 0

  useEffect(() => {
    if (previousStepRef.current === currentStep) return
    previousStepRef.current = currentStep
    if (!allowAutoScrollRef.current) return
    const target =
      currentStep === 'receipt'
        ? receiptFormRef.current
        : currentStep === 'qc'
          ? qcSectionRef.current
          : putawayFormRef.current
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [currentStep])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Inbound</p>
          <h2 className="text-2xl font-semibold text-slate-900">Receiving & Putaway</h2>
        </div>
      </div>

      <Section
        title="Receiving workspace"
        description="Confirm receipt, classify QC, and put away accepted quantities."
      >
        <Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-6">
              <form id="receipt-form" ref={receiptFormRef} className="space-y-4" onSubmit={onCreateReceipt}>
                <div className="rounded-lg border border-slate-200 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Receipt</div>
                      <p className="text-xs text-slate-500">Record what arrived. Only accepted quantity becomes usable.</p>
                    </div>
                    <Badge variant={receiptPostedForSelectedPo ? 'success' : 'neutral'}>
                      {receiptPostedForSelectedPo ? 'Posted' : 'Draft'}
                    </Badge>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Purchase order</span>
                      <select
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                        value={selectedPoId}
                        onChange={(e) => handlePoChange(e.target.value)}
                      >
                        <option value="">Select PO</option>
                        {poListQuery.data?.data
                          .filter((po) => po.status !== 'received' && po.status !== 'closed' && po.status !== 'canceled')
                          .map((po) => (
                            <option key={po.id} value={po.id}>
                              {po.poNumber} ({po.status})
                            </option>
                          ))}
                      </select>
                    </label>
                    <div>
                      <Combobox
                        label="Received to location"
                        value={resolvedReceivedToLocationId}
                        options={locationOptions}
                        loading={locationsQuery.isLoading}
                        onQueryChange={setLocationSearch}
                        placeholder="Search locations (code/name)"
                        onChange={(nextValue) => setReceivedToLocationId(nextValue)}
                      />
                    </div>
                  </div>
                  {poQuery.isLoading && <LoadingSpinner label="Loading PO..." />}
                  {poQuery.isError && poQuery.error && (
                    <Alert variant="error" title="PO load failed" message={(poQuery.error as ApiError).message} />
                  )}
                  {poQuery.data && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-sm font-semibold text-slate-800">
                        PO {poQuery.data.poNumber}
                      </div>
                      <div className="text-xs text-slate-600">
                        Vendor: {poQuery.data.vendorCode ?? poQuery.data.vendorId}
                        {poQuery.data.vendorName ? ` — ${poQuery.data.vendorName}` : ''}
                      </div>
                      <div className="text-xs text-slate-500">
                        Expected lines: {resolvedReceiptLineInputs.length}
                      </div>
                    </div>
                  )}
                  {poClosed && (
                    <Alert
                      variant="info"
                      title="Receipt locked"
                      message="This PO is fully received, closed, or canceled."
                    />
                  )}
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">Receipt lines</div>
                        <p className="text-xs text-slate-500">Match expected vs received.</p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={resetReceiptLines}
                        disabled={resolvedReceiptLineInputs.length === 0}
                      >
                        Reset to expected
                      </Button>
                    </div>
                    {resolvedReceiptLineInputs.length === 0 ? (
                      <div className="mt-3 text-sm text-slate-600">No PO lines to receive.</div>
                    ) : (
                      <div className="mt-3">
                        <ReceiptLinesTable
                          lines={resolvedReceiptLineInputs}
                          onLineChange={updateReceiptLine}
                          emptyMessage="No PO lines to receive."
                        />
                      </div>
                    )}
                  </div>
                  <div className="grid gap-2 md:grid-cols-5">
                    {[
                      { label: 'Received', value: receiptTotals.received },
                      { label: 'Accepted', value: receiptTotals.accepted },
                      { label: 'On hold', value: receiptTotals.hold },
                      { label: 'Rejected', value: receiptTotals.reject },
                      { label: 'Unclassified', value: receiptTotals.remaining },
                    ].map((card) => (
                      <div key={card.label} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="text-xs uppercase tracking-wide text-slate-500">{card.label}</div>
                        <div className="text-lg font-semibold text-slate-900">
                          {formatNumber(card.value)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Receipt notes</span>
                    <Textarea
                      value={receiptNotes}
                      onChange={(e) => setReceiptNotes(e.target.value)}
                      placeholder="Optional context for discrepancies."
                    />
                  </label>
                </div>
              </form>

              <div ref={qcSectionRef} className="rounded-lg border border-slate-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Receipt context</div>
                    <p className="text-xs text-slate-500">Load a receipt to QC and plan putaway.</p>
                  </div>
                  <div className="text-xs text-slate-500">
                    {recentReceiptsQuery.data?.data?.length ?? 0} recent
                  </div>
                </div>
                {!recentReceiptsQuery.isLoading && (recentReceiptsQuery.data?.data?.length ?? 0) === 0 && (
                  <div className="text-sm text-slate-600">No receipts yet.</div>
                )}
                {recentReceiptsQuery.isLoading && <LoadingSpinner label="Loading recent receipts..." />}
                {!recentReceiptsQuery.isLoading && (recentReceiptsQuery.data?.data?.length ?? 0) > 0 && (
                  <RecentReceiptsTable
                    receipts={recentReceiptsQuery.data?.data ?? []}
                    onLoad={updateReceiptIdForPutaway}
                    onVoid={(id) => voidReceiptMutation.mutate(id)}
                    voidDisabled={voidReceiptMutation.isPending}
                  />
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Receipt ID</span>
                    <Input
                      value={receiptIdForPutaway}
                      onChange={(e) => updateReceiptIdForPutaway(e.target.value)}
                      placeholder="Receipt UUID"
                    />
                  </label>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => receiptIdForPutaway && void receiptQuery.refetch()}
                      disabled={!receiptIdForPutaway}
                    >
                      Load receipt
                    </Button>
                  </div>
                </div>
                {receiptQuery.isLoading && <LoadingSpinner label="Loading receipt..." />}
                {receiptQuery.isError && receiptQuery.error && (
                  <Alert variant="error" title="Receipt load failed" message={(receiptQuery.error as ApiError).message} />
                )}
              </div>

              <div className="rounded-lg border border-slate-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">QC lines</div>
                    <p className="text-xs text-slate-500">Pick a line to classify.</p>
                  </div>
                  <Badge variant={!receiptLoaded ? 'neutral' : qcNeedsAttention ? 'warning' : 'success'}>
                    {!receiptLoaded ? 'Load receipt' : qcNeedsAttention ? 'Needs QC' : 'QC complete'}
                  </Badge>
                </div>
                {receiptQuery.data ? (
                  <div className="overflow-x-auto">
                    <QcLinesTable
                      lines={receiptQuery.data.lines ?? []}
                      activeLineId={activeQcLineId}
                      onSelectLine={setSelectedQcLineId}
                      receiptId={receiptQuery.data.id}
                    />
                  </div>
                ) : (
                  <div className="text-sm text-slate-600">Load a receipt to start QC.</div>
                )}
              </div>

              <form
                id="putaway-form"
                ref={putawayFormRef}
                className="rounded-lg border border-slate-200 p-3 space-y-3"
                onSubmit={onCreatePutaway}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Putaway lines</div>
                    <p className="text-xs text-slate-500">Plan moves for accepted quantities.</p>
                  </div>
                  <Badge variant={putawayReady ? 'success' : 'neutral'}>
                    {putawayReady ? 'Ready' : 'Draft'}
                  </Badge>
                </div>
                <PutawayLinesEditor
                  lines={putawayLines}
                  receiptLineOptions={receiptLineOptions}
                  locationOptions={locationOptions}
                  locationsLoading={locationsQuery.isLoading}
                  onLocationSearch={setLocationSearch}
                  onLineChange={updatePutawayLine}
                  resolvePutawayDefaults={resolvePutawayDefaults}
                />
              </form>
            </div>

            <aside
              ref={workflowRailRef}
              className={`space-y-4 self-start ${isWorkflowSticky ? 'sticky top-4' : ''}`}
            >
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">Workflow</div>
                <div className="mt-2 space-y-2">
                  {stepper.map((step, idx) => {
                    const isCurrent = step.key === currentStep
                    const isComplete = step.complete
                    const badgeVariant = isComplete ? 'success' : step.blocked ? 'warning' : isCurrent ? 'info' : 'neutral'
                    const badgeLabel = isComplete ? 'Done' : step.blocked ? 'Blocked' : isCurrent ? 'Current' : 'Next'
                    return (
                      <div key={step.key} className="rounded-md border border-slate-200 px-2 py-2">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold text-slate-800">
                            {idx + 1}. {step.label}
                          </div>
                          <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                        </div>
                        {step.blocked && (
                          <div className="mt-1 text-xs text-amber-700">Blocked: {step.blocked}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {currentStep === 'receipt' && (
                <div className="space-y-3">
                  {receiptMutation.isError && (
                    <Alert
                      variant="error"
                      title="Receipt not saved"
                      message={
                        receiptErrorMap[getErrorMessage(receiptMutation.error, '')] ??
                        getErrorMessage(receiptMutation.error, 'Unable to save receipt.')
                      }
                    />
                  )}
                  {receiptMutation.isPending && (
                    <Alert
                      variant="info"
                      title="Posting receipt"
                      message="Recording arrival. Inventory becomes usable after QC + putaway."
                    />
                  )}
                  {receiptMutation.isSuccess && receiptMutation.data && (
                    <Alert
                      variant="success"
                      title="Receipt posted"
                      message={`Receipt ${receiptMutation.data.id.slice(0, 8)}… posted.`}
                      action={
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => updateReceiptIdForPutaway(receiptMutation.data?.id ?? '')}
                        >
                          Load receipt
                        </Button>
                      }
                    />
                  )}
                  {receiptPostedForSelectedPo && !receiptMutation.isPending && (
                    <Alert
                      variant="info"
                      title="Receipt already posted"
                      message="Load it below to continue with QC and putaway."
                    />
                  )}
                  {receiptLineSummary.missingReasons.length > 0 && (
                    <Alert
                      variant="warning"
                      title="Discrepancy reason required"
                      message="Add a reason for each line where received ≠ expected."
                    />
                  )}
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Discrepancies</div>
                    <ReceiptSummaryPanel
                      summary={receiptLineSummary}
                      totalLines={resolvedReceiptLineInputs.length}
                      discrepancyLabels={discrepancyLabels}
                    />
                  </div>
                  <Button
                    type="submit"
                    form="receipt-form"
                    size="sm"
                    disabled={!canPostReceipt}
                  >
                    {receiptMutation.isPending ? 'Posting…' : 'Post receipt'}
                  </Button>
                </div>
              )}

              {currentStep === 'qc' && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Selected line</div>
                    {selectedQcLine ? (
                      <div className="mt-2 grid gap-2">
                        {[
                          { label: 'Received', value: selectedLineTotals.received },
                          { label: 'Accepted', value: selectedLineTotals.accepted },
                          { label: 'Hold', value: selectedLineTotals.hold },
                          { label: 'Rejected', value: selectedLineTotals.reject },
                          { label: 'Remaining', value: selectedLineTotals.remaining },
                        ].map((card) => (
                          <div key={card.label} className="flex items-center justify-between text-sm text-slate-700">
                            <span>{card.label}</span>
                            <span className="font-semibold text-slate-900">{formatNumber(card.value)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-slate-600">Select a QC line to continue.</div>
                    )}
                  </div>
                  {!receiptQuery.data && (
                    <Alert
                      variant="info"
                      title="Load a receipt"
                      message="Select a receipt to start QC classification."
                    />
                  )}
                  {receiptQuery.data && !selectedQcLine && (
                    <Alert
                      variant="info"
                      title="Select a line to QC"
                      message="Pick a receipt line to classify accepted, hold, or rejected quantities."
                    />
                  )}
                  {selectedQcLine && (
                    <QcDetailPanel
                      line={selectedQcLine}
                      qcStats={selectedQcStats ?? { accept: 0, hold: 0, reject: 0, remaining: 0 }}
                      qcRemaining={qcRemaining}
                      qcEventType={qcEventType}
                      qcQuantity={qcQuantity}
                      qcReasonCode={qcReasonCode}
                      qcNotes={qcNotes}
                      qcQuantityInvalid={qcQuantityInvalid}
                      canRecordQc={canRecordQc}
                      qcEvents={qcEventsList}
                      qcEventsLoading={qcEventsQuery.isLoading}
                      qcEventsError={qcEventsQuery.isError}
                      lastEvent={activeLastQcEvent}
                      mutationErrorMessage={
                        qcEventMutation.isError
                          ? qcErrorMap[getErrorMessage(qcEventMutation.error, '')] ??
                            getErrorMessage(qcEventMutation.error, 'Unable to record QC event.')
                          : undefined
                      }
                      mutationPending={qcEventMutation.isPending}
                      onEventTypeChange={(eventType) => updateQcDraft({ eventType })}
                      onQuantityChange={(value) => updateQcDraft({ quantity: value })}
                      onReasonCodeChange={(value) => updateQcDraft({ reasonCode: value })}
                      onNotesChange={(value) => updateQcDraft({ notes: value })}
                      onRecord={onCreateQcEvent}
                      putawayAvailable={selectedPutawayAvailable}
                      putawayBlockedReason={selectedQcLine.putawayBlockedReason}
                    />
                  )}
                </div>
              )}

              {currentStep === 'putaway' && (
                <div className="space-y-3">
                  {putawayMutation.isError && (
                    <Alert
                      variant="error"
                      title="Putaway draft not saved"
                      message={
                        mapErrorMessage(
                          putawayCreateErrorMap[getErrorMessage(putawayMutation.error, '')] ??
                            getErrorMessage(putawayMutation.error, ''),
                          putawayCreateErrorMap,
                        ) || 'Unable to save the putaway draft.'
                      }
                    />
                  )}
                  {putawayMutation.isPending && (
                    <Alert variant="info" title="Saving putaway draft" message="Planning the move." />
                  )}
                  {putawayMutation.isSuccess && putawayMutation.data && (
                    <Alert
                      variant="success"
                      title="Putaway draft saved"
                      message={`Draft ${putawayMutation.data.id.slice(0, 8)}… ready to post.`}
                    />
                  )}
                  {postPutawayMutation.isError && (
                    <Alert
                      variant={getErrorMessage(postPutawayMutation.error, '') === 'Putaway already posted.' ? 'info' : 'error'}
                      title={getErrorMessage(postPutawayMutation.error, '') === 'Putaway already posted.' ? 'Putaway already posted' : 'Putaway not posted'}
                      message={
                        mapErrorMessage(
                          putawayPostErrorMap[getErrorMessage(postPutawayMutation.error, '')] ??
                            getErrorMessage(postPutawayMutation.error, ''),
                          putawayPostErrorMap,
                        ) || 'Unable to post the putaway.'
                      }
                    />
                  )}
                  {postPutawayMutation.isPending && (
                    <Alert
                      variant="warning"
                      title="Posting putaway"
                      message="Creating inventory movements."
                    />
                  )}
                  {postPutawayMutation.isSuccess && postPutawayMutation.data && (
                    <Alert
                      variant="success"
                      title="Putaway posted"
                      message={`Movement ${postPutawayMutation.data.inventoryMovementId ?? 'created'}; putaway ${postPutawayMutation.data.id.slice(0, 8)}… completed.`}
                    />
                  )}
                  {putawayResumeNotice && (
                    <Alert variant="info" title="Putaway draft loaded" message={putawayResumeNotice} />
                  )}
                  {putawayFillNotice && (
                    <Alert variant="info" title="No putaway lines added" message={putawayFillNotice} />
                  )}
                  {putawayQcIssues.length > 0 && (
                    <Alert
                      variant="warning"
                      title="Putaway blocked by QC"
                      message="Some lines have no available quantity for putaway."
                    />
                  )}
                  {putawayQuantityIssues.length > 0 && (
                    <Alert
                      variant="warning"
                      title="Reduce quantities"
                      message="One or more lines exceed the available quantity."
                    />
                  )}
                  {putawayBlockingLine && (
                    <Alert
                      variant="warning"
                      title="Putaway blocked"
                      message="Hold > 0 and Accept = 0 on a line."
                      action={
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelectedQcLineId(putawayBlockingLine.id)}
                        >
                          Review line
                        </Button>
                      }
                    />
                  )}
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Rule</div>
                    <div className="text-sm text-slate-700">
                      Only accepted quantity becomes usable inventory.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={fillPutawayFromReceipt}
                      disabled={!receiptQuery.data?.lines?.length}
                    >
                      Use receipt lines
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={addPutawayLine}>
                      Add line
                    </Button>
                  </div>
                  <Button
                    type="submit"
                    form="putaway-form"
                    size="sm"
                    variant={putawayId ? 'secondary' : 'primary'}
                    disabled={!canCreatePutaway}
                  >
                    {putawayMutation.isPending ? 'Saving…' : 'Create putaway'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={putawayId ? 'primary' : 'secondary'}
                    disabled={!putawayId || postPutawayMutation.isPending || putawayMutation.isPending}
                    onClick={() => {
                      if (!putawayId) return
                      allowAutoScrollRef.current = true
                      postPutawayMutation.reset()
                      postPutawayMutation.mutate(putawayId)
                    }}
                  >
                    {postPutawayMutation.isPending ? 'Posting…' : 'Post putaway'}
                  </Button>
                </div>
              )}
            </aside>
          </div>
        </Card>
      </Section>

      {putawayQuery.data && (
        <Section title="Last putaway">
          <Card>
            <PutawaySummaryTable putaway={putawayQuery.data} />
          </Card>
        </Section>
      )}
    </div>
  )
}
