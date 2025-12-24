import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listPurchaseOrders, getPurchaseOrder } from '../../../api/endpoints/purchaseOrders'
import { createReceipt, type ReceiptCreatePayload, getReceipt, listReceipts, deleteReceiptApi } from '../../../api/endpoints/receipts'
import { createPutaway, postPutaway, type PutawayCreatePayload, getPutaway } from '../../../api/endpoints/putaways'
import { createQcEvent, listQcEventsForLine, type QcEventCreatePayload } from '../../../api/endpoints/qc'
import type { ApiError, Location, PurchaseOrder, PurchaseOrderReceipt, Putaway, PurchaseOrderReceiptLine, QcEvent } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { listLocations } from '../../../api/endpoints/locations'
import { Combobox } from '../../../components/Combobox'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { useDebouncedValue } from '../../../lib/useDebouncedValue'
import { useAuth } from '../../../lib/auth'

type ReceiptLineInput = {
  purchaseOrderLineId: string
  lineNumber: number
  itemLabel: string
  uom: string
  expectedQty: number
  receivedQty: number | ''
  discrepancyReason: '' | 'short' | 'over' | 'damaged' | 'substituted'
  discrepancyNotes: string
}

export default function ReceivingPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [selectedPoId, setSelectedPoId] = useState('')
  const [receiptLineInputs, setReceiptLineInputs] = useState<ReceiptLineInput[]>([])
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receivedToLocationId, setReceivedToLocationId] = useState('')
  const [receiptIdForPutaway, setReceiptIdForPutaway] = useState('')
  const [selectedQcLineId, setSelectedQcLineId] = useState('')
  const [qcEventType, setQcEventType] = useState<'accept' | 'hold' | 'reject'>('accept')
  const [qcQuantity, setQcQuantity] = useState<number | ''>('')
  const [qcReasonCode, setQcReasonCode] = useState('')
  const [qcNotes, setQcNotes] = useState('')
  const [lastQcEvent, setLastQcEvent] = useState<QcEvent | null>(null)
  const [putawayFillNotice, setPutawayFillNotice] = useState<string | null>(null)
  const [putawayLines, setPutawayLines] = useState<
    {
      purchaseOrderReceiptLineId: string
      toLocationId: string
      fromLocationId: string
      uom: string
      quantity: number | ''
    }[]
  >([{ purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' }])
  const [locationSearch, setLocationSearch] = useState('')
  const [putawayId, setPutawayId] = useState('')
  const poIdFromQuery = searchParams.get('poId') ?? ''
  const poListQuery = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => listPurchaseOrders({ limit: 200 }),
    staleTime: 60_000,
  })

  const poQuery = useQuery<PurchaseOrder>({
    queryKey: ['purchase-order', selectedPoId],
    queryFn: () => getPurchaseOrder(selectedPoId),
    enabled: !!selectedPoId,
  })

  const buildReceiptLines = (po: PurchaseOrder): ReceiptLineInput[] => {
    return (po.lines ?? []).map((line, idx) => {
      const sku = line.itemSku ?? line.itemId ?? 'Item'
      const name = line.itemName ?? ''
      const label = `${sku}${name ? ` — ${name}` : ''}`
      return {
        purchaseOrderLineId: line.id,
        lineNumber: line.lineNumber ?? idx + 1,
        itemLabel: label,
        uom: line.uom ?? '',
        expectedQty: line.quantityOrdered ?? 0,
        receivedQty: line.quantityOrdered ?? 0,
        discrepancyReason: '',
        discrepancyNotes: '',
      }
    })
  }

  const discrepancyLabels: Record<ReceiptLineInput['discrepancyReason'], string> = {
    '': 'No variance',
    short: 'Short',
    over: 'Over',
    damaged: 'Damaged',
    substituted: 'Substituted',
  }

  const getQcBreakdown = (line: PurchaseOrderReceiptLine) => {
    const breakdown = line.qcSummary?.breakdown ?? { accept: 0, hold: 0, reject: 0 }
    const totalQc = breakdown.accept + breakdown.hold + breakdown.reject
    const remaining =
      line.qcSummary?.remainingUninspectedQuantity ?? Math.max(0, line.quantityReceived - totalQc)
    return { ...breakdown, remaining, totalQc }
  }

  const getQcStatus = (line: PurchaseOrderReceiptLine) => {
    const { totalQc, remaining } = getQcBreakdown(line)
    if (totalQc === 0) {
      return { label: 'QC not started', tone: 'bg-slate-100 text-slate-600' }
    }
    if (remaining > 0) {
      return { label: 'QC in progress', tone: 'bg-amber-100 text-amber-700' }
    }
    return { label: 'QC complete', tone: 'bg-emerald-100 text-emerald-700' }
  }

  useEffect(() => {
    if (poIdFromQuery) {
      setSelectedPoId(poIdFromQuery)
    }
  }, [poIdFromQuery])

  useEffect(() => {
    if (!poQuery.data?.id) return
    setReceivedToLocationId(
      poQuery.data.receivingLocationId ?? poQuery.data.shipToLocationId ?? '',
    )
    setReceiptLineInputs(buildReceiptLines(poQuery.data))
    setReceiptNotes('')
  }, [poQuery.data?.id])

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

  const receiptQuery = useQuery<PurchaseOrderReceipt>({
    queryKey: ['receipt', receiptIdForPutaway],
    queryFn: () => getReceipt(receiptIdForPutaway),
    enabled: !!receiptIdForPutaway,
  })

  const selectedQcLine = useMemo(() => {
    if (!selectedQcLineId) return undefined
    return receiptQuery.data?.lines?.find((line) => line.id === selectedQcLineId)
  }, [receiptQuery.data?.lines, selectedQcLineId])

  const qcEventsQuery = useQuery<{ data: QcEvent[] }, ApiError>({
    queryKey: ['qc-events', selectedQcLineId],
    queryFn: () => listQcEventsForLine(selectedQcLineId),
    enabled: !!selectedQcLineId,
    staleTime: 30_000,
  })

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
  }

  const qcEventMutation = useMutation({
    mutationFn: (payload: QcEventCreatePayload) => createQcEvent(payload),
    onSuccess: (event) => {
      setLastQcEvent(event)
      setQcNotes('')
      setQcReasonCode('')
      void queryClient.invalidateQueries({ queryKey: ['receipt', receiptIdForPutaway] })
      void queryClient.invalidateQueries({ queryKey: ['qc-events', selectedQcLineId] })
      void recentReceiptsQuery.refetch()
    },
  })

  const receiptLineOptions = useMemo(() => {
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

  const putawayQuery = useQuery<Putaway>({
    queryKey: ['putaway', putawayId],
    queryFn: () => getPutaway(putawayId),
    enabled: !!putawayId,
  })

  const recentReceiptsQuery = useQuery({
    queryKey: ['recent-receipts'],
    queryFn: () => listReceipts({ limit: 20 }),
    staleTime: 30_000,
  })

  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)

  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'receiving-putaway', debouncedLocationSearch],
    queryFn: () =>
      listLocations({ limit: 200, search: debouncedLocationSearch || undefined, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )

  const receiptLineSummary = useMemo(() => {
    const lines = receiptLineInputs.map((line) => {
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
  }, [receiptLineInputs])

  const receiptMutation = useMutation({
    mutationFn: (payload: ReceiptCreatePayload) => createReceipt(payload),
    onSuccess: (receipt) => {
      setReceiptIdForPutaway(receipt.id)
      setPutawayLines([{ purchaseOrderReceiptLineId: '', toLocationId: '', fromLocationId: '', uom: '', quantity: '' }])
      void recentReceiptsQuery.refetch()
    },
  })
  const deleteReceiptMutation = useMutation({
    mutationFn: (id: string) => deleteReceiptApi(id),
    onSuccess: () => {
      void recentReceiptsQuery.refetch()
      if (receiptIdForPutaway) setReceiptIdForPutaway('')
    },
  })

  const putawayMutation = useMutation({
    mutationFn: (payload: PutawayCreatePayload) => createPutaway(payload),
    onSuccess: (p) => {
      setPutawayId(p.id)
      void queryClient.invalidateQueries({ queryKey: ['receipt', receiptIdForPutaway] })
      void recentReceiptsQuery.refetch()
    },
  })

  const postPutawayMutation = useMutation({
    mutationFn: (id: string) => postPutaway(id),
    onSuccess: (p) => {
      setPutawayId(p.id)
      void putawayQuery.refetch()
    },
    onError: (error) => {
      if (getErrorMessage(error, '') === 'Putaway already posted.') {
        void putawayQuery.refetch()
      }
    },
  })

  const resetReceiptLines = () => {
    if (!poQuery.data) return
    setReceiptLineInputs(buildReceiptLines(poQuery.data))
  }

  useEffect(() => {
    const lines = receiptQuery.data?.lines ?? []
    if (!lines.length) {
      setSelectedQcLineId('')
      return
    }
    const hasSelected = lines.some((line) => line.id === selectedQcLineId)
    if (!selectedQcLineId || !hasSelected) {
      const nextLine = lines.find((line) => getQcBreakdown(line).remaining > 0) ?? lines[0]
      setSelectedQcLineId(nextLine.id)
      return
    }
    const selected = lines.find((line) => line.id === selectedQcLineId)
    if (!selected) return
    if (getQcBreakdown(selected).remaining <= 0) {
      const nextLine = lines.find((line) => getQcBreakdown(line).remaining > 0)
      if (nextLine && nextLine.id !== selectedQcLineId) {
        setSelectedQcLineId(nextLine.id)
      }
    }
  }, [receiptQuery.data?.lines, selectedQcLineId])

  useEffect(() => {
    if (!selectedQcLine) {
      setQcQuantity('')
      return
    }
    setQcEventType('accept')
    const remaining = getQcBreakdown(selectedQcLine).remaining
    setQcQuantity((prev) => {
      if (remaining <= 0) return ''
      if (prev === '' || prev > remaining) return remaining
      return prev
    })
  }, [selectedQcLine])

  useEffect(() => {
    setLastQcEvent(null)
  }, [selectedQcLineId])

  useEffect(() => {
    if (qcEventType === 'accept') {
      setQcReasonCode('')
      setQcNotes('')
    }
  }, [qcEventType])

  useEffect(() => {
    setPutawayFillNotice(null)
  }, [receiptIdForPutaway])

  const updateReceiptLine = (lineId: string, patch: Partial<ReceiptLineInput>) => {
    setReceiptLineInputs((prev) => prev.map((line) => (line.purchaseOrderLineId === lineId ? { ...line, ...patch } : line)))
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
    receiptMutation.mutate({
      purchaseOrderId: selectedPoId,
      receivedAt: new Date().toISOString(),
      receivedToLocationId: receivedToLocationId || undefined,
      notes: composedNotes || undefined,
      lines,
    })
  }

  const onCreateQcEvent = () => {
    if (!selectedQcLine) return
    if (qcQuantityInvalid) return
    qcEventMutation.reset()
    setLastQcEvent(null)
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
    putawayMutation.mutate({
      sourceType: 'purchase_order_receipt',
      purchaseOrderReceiptId: receiptIdForPutaway,
      lines,
    })
  }

  const canPostReceipt =
    !!selectedPoId &&
    receiptLineSummary.receivedLines.length > 0 &&
    receiptLineSummary.missingReasons.length === 0 &&
    !receiptMutation.isPending
  const selectedQcStats = selectedQcLine ? getQcBreakdown(selectedQcLine) : null
  const selectedPutawayAvailable =
    selectedQcLine?.availableForNewPutaway ?? selectedQcLine?.remainingQuantityToPutaway ?? 0
  const qcRemaining = selectedQcStats?.remaining ?? 0
  const qcQuantityNumber = qcQuantity === '' ? 0 : Number(qcQuantity)
  const qcQuantityInvalid =
    !selectedQcLine || qcQuantityNumber <= 0 || qcQuantityNumber - qcRemaining > 1e-6
  const canRecordQc =
    !qcEventMutation.isPending &&
    !!selectedQcLine &&
    qcRemaining > 0 &&
    !qcQuantityInvalid
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Inbound</p>
          <h2 className="text-2xl font-semibold text-slate-900">Receiving & Putaway</h2>
        </div>
      </div>

      <Section
        title="Record a receipt"
        description="Step 1: confirm what physically arrived. Posting a receipt updates inventory and locks this record."
      >
        <Card>
          <form className="space-y-4" onSubmit={onCreateReceipt}>
            {receiptMutation.isError && (
              <Alert
                variant="error"
                title="Receipt not saved"
                message={
                  receiptErrorMap[getErrorMessage(receiptMutation.error, '')] ??
                  getErrorMessage(receiptMutation.error, 'Unable to save receipt. Check the lines and try again.')
                }
              />
            )}
            {receiptMutation.isPending && (
              <Alert
                variant="info"
                title="Saving receipt"
                message="Posting the receipt and updating inventory. Please wait…"
              />
            )}
            {receiptMutation.isSuccess && receiptMutation.data && (
              <Alert
                variant="success"
                title="Receipt posted"
                message={`Receipt ${receiptMutation.data.id.slice(0, 8)}… posted. Use Item → Stock for authoritative totals. Next: create a putaway when you're ready.`}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setReceiptIdForPutaway(receiptMutation.data?.id ?? '')}
                  >
                    Load receipt
                  </Button>
                }
              />
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Purchase order (open or partial)</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={selectedPoId}
                  onChange={(e) => setSelectedPoId(e.target.value)}
                >
                  <option value="">Select PO</option>
                  {poListQuery.data?.data
                    .filter((po) => po.status !== 'received' && po.status !== 'closed')
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
                  value={receivedToLocationId}
                  options={locationOptions}
                  loading={locationsQuery.isLoading}
                  onQueryChange={setLocationSearch}
                  placeholder="Search locations (code/name)"
                  onChange={(nextValue) => setReceivedToLocationId(nextValue)}
                />
                <p className="mt-1 text-xs text-slate-500">Use a staging/receiving location to defer putaway.</p>
              </div>
            </div>
            {poQuery.isLoading && <LoadingSpinner label="Loading PO..." />}
            {poQuery.isError && poQuery.error && (
              <Alert variant="error" title="PO load failed" message={(poQuery.error as ApiError).message} />
            )}
            {poQuery.data && (
              <div className="space-y-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-sm font-semibold text-slate-800">
                    PO {poQuery.data.poNumber}
                  </div>
                  <div className="text-xs text-slate-600">
                    Vendor: {poQuery.data.vendorCode ?? poQuery.data.vendorId}
                    {poQuery.data.vendorName ? ` — ${poQuery.data.vendorName}` : ''}
                  </div>
                  <div className="text-xs text-slate-500">
                    Expected lines: {receiptLineInputs.length}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Step 2: Record receipt lines</div>
                      <p className="text-xs text-slate-500">
                        Expected vs received are paired. Lines with 0 received are treated as not received.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={resetReceiptLines}
                      disabled={receiptLineInputs.length === 0}
                    >
                      Reset to expected
                    </Button>
                  </div>
                  {receiptLineInputs.length === 0 ? (
                    <div className="mt-3 text-sm text-slate-600">No PO lines to receive.</div>
                  ) : (
                    <div className="mt-3 overflow-hidden rounded border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Line</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Item</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Expected</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Received</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Delta</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Discrepancy</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 bg-white">
                          {receiptLineInputs.map((line) => {
                            const receivedQty = line.receivedQty === '' ? 0 : Number(line.receivedQty)
                            const expectedQty = line.expectedQty ?? 0
                            const delta = receivedQty - expectedQty
                            const hasVariance = delta !== 0
                            const deltaLabel = hasVariance
                              ? delta > 0
                                ? `Over by ${delta}`
                                : `Short by ${Math.abs(delta)}`
                              : 'On target'
                            const deltaTone = hasVariance ? 'text-amber-700' : 'text-slate-500'
                            const needsReason = hasVariance && !line.discrepancyReason
                            return (
                              <tr key={line.purchaseOrderLineId}>
                                <td className="px-3 py-2 text-sm text-slate-800">{line.lineNumber}</td>
                                <td className="px-3 py-2 text-sm text-slate-800">{line.itemLabel}</td>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  {expectedQty} {line.uom}
                                </td>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  <Input
                                    type="number"
                                    min={0}
                                    value={line.receivedQty}
                                    onChange={(e) => {
                                      const nextValue = e.target.value === '' ? '' : Number(e.target.value)
                                      const nextReceived = nextValue === '' ? 0 : Number(nextValue)
                                      const nextDelta = nextReceived - expectedQty
                                      let nextReason = line.discrepancyReason
                                      let nextNotes = line.discrepancyNotes
                                      if (nextDelta === 0) {
                                        nextReason = ''
                                        nextNotes = ''
                                      } else if (!nextReason) {
                                        nextReason = nextDelta > 0 ? 'over' : 'short'
                                      }
                                      updateReceiptLine(line.purchaseOrderLineId, {
                                        receivedQty: nextValue,
                                        discrepancyReason: nextReason,
                                        discrepancyNotes: nextNotes,
                                      })
                                    }}
                                  />
                                </td>
                                <td className={`px-3 py-2 text-sm ${deltaTone}`}>{deltaLabel}</td>
                                <td className="px-3 py-2 text-sm text-slate-800">
                                  {hasVariance ? (
                                    <div className="space-y-1">
                                      <select
                                        className={`w-full rounded-lg border px-2 py-1 text-sm ${
                                          needsReason ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
                                        }`}
                                        value={line.discrepancyReason}
                                        onChange={(e) =>
                                          updateReceiptLine(line.purchaseOrderLineId, {
                                            discrepancyReason: e.target.value as ReceiptLineInput['discrepancyReason'],
                                          })
                                        }
                                      >
                                        <option value="">Select reason</option>
                                        <option value="short">Short</option>
                                        <option value="over">Over</option>
                                        <option value="damaged">Damaged</option>
                                        <option value="substituted">Substituted</option>
                                      </select>
                                      {(line.discrepancyReason === 'damaged' || line.discrepancyReason === 'substituted') && (
                                        <Input
                                          value={line.discrepancyNotes}
                                          onChange={(e) =>
                                            updateReceiptLine(line.purchaseOrderLineId, {
                                              discrepancyNotes: e.target.value,
                                            })
                                          }
                                          placeholder="Notes (optional)"
                                        />
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-slate-500">No variance</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Receipt notes (optional)</span>
                  <Textarea
                    value={receiptNotes}
                    onChange={(e) => setReceiptNotes(e.target.value)}
                    placeholder="Context for discrepancies, handling notes, or carrier references."
                  />
                </label>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-sm font-semibold text-slate-800">Step 3: Review summary</div>
                  <div className="mt-2 grid gap-2 md:grid-cols-3 text-sm text-slate-700">
                    <div>
                      Lines received: {receiptLineSummary.receivedLines.length} / {receiptLineInputs.length}
                    </div>
                    <div>Lines remaining: {receiptLineSummary.remainingLines.length}</div>
                    <div>Discrepancies: {receiptLineSummary.discrepancyLines.length}</div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    Total expected {receiptLineSummary.totalExpected} · Total received {receiptLineSummary.totalReceived}
                  </div>
                  {receiptLineSummary.discrepancyLines.length > 0 && (
                    <div className="mt-2 text-xs text-slate-600">
                      <div className="font-semibold text-slate-700">Discrepancies</div>
                      <ul className="mt-1 list-disc pl-4">
                        {receiptLineSummary.discrepancyLines.map((line) => {
                          const deltaLabel =
                            line.delta > 0 ? `over by ${line.delta}` : `short by ${Math.abs(line.delta)}`
                          const reason = line.discrepancyReason
                            ? discrepancyLabels[line.discrepancyReason]
                            : 'Reason required'
                          const note = line.discrepancyNotes ? ` — ${line.discrepancyNotes}` : ''
                          return (
                            <li key={line.purchaseOrderLineId}>
                              {line.itemLabel}: expected {line.expectedQty} {line.uom}, received {line.receivedQty}{' '}
                              {line.uom} ({deltaLabel}) · {reason}
                              {note}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                  {receiptLineSummary.receivedLines.length === 0 && (
                    <div className="mt-2">
                      <Alert
                        variant="warning"
                        title="No received quantities"
                        message="Enter at least one received quantity to post a receipt."
                      />
                    </div>
                  )}
                  {receiptLineSummary.missingReasons.length > 0 && (
                    <div className="mt-2">
                      <Alert
                        variant="warning"
                        title="Discrepancy reason required"
                        message={`Select a reason for ${receiptLineSummary.missingReasons.length} line(s) with a variance.`}
                      />
                    </div>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    Posting creates a receipt, updates inventory immediately, and locks this record.
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Discrepancies are recorded in the receipt notes for auditability.
                  </p>
                </div>
              </div>
            )}
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!canPostReceipt}>
                {receiptMutation.isPending ? 'Posting…' : 'Post receipt'}
              </Button>
            </div>
          </form>
        </Card>
      </Section>

      <Section
        title="Quality check and putaway"
        description="Step 4: classify usable inventory. Step 5: move accepted inventory to storage."
      >
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-800">Recent receipts</div>
              <p className="text-xs text-slate-500">Select a receipt to load its lines for putaway.</p>
            </div>
            <div className="text-xs text-slate-500">
              Showing {recentReceiptsQuery.data?.data?.length ?? 0} of recent receipts
            </div>
          </div>
          {!recentReceiptsQuery.isLoading && (recentReceiptsQuery.data?.data?.length ?? 0) === 0 && (
            <div className="mt-2 text-sm text-slate-600">No receipts yet.</div>
          )}
          {recentReceiptsQuery.isLoading && <LoadingSpinner label="Loading recent receipts..." />}
          {!recentReceiptsQuery.isLoading && (recentReceiptsQuery.data?.data?.length ?? 0) > 0 && (
            <div className="mt-2 overflow-hidden rounded border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Receipt</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">PO</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Received at</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Putaway</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {recentReceiptsQuery.data?.data?.map((rec) => (
                    <tr
                      key={rec.id}
                      className="hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <button type="button" className="text-brand-700 underline" onClick={() => setReceiptIdForPutaway(rec.id)}>
                          {rec.id.slice(0, 8)}…
                        </button>
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{rec.purchaseOrderId}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{rec.receivedAt}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                            rec.hasPutaway
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {rec.hasPutaway ? 'Putaway started' : 'Not started'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-sm text-slate-800">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setReceiptIdForPutaway(rec.id)}
                          >
                            Load
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={deleteReceiptMutation.isPending}
                            onClick={() => {
                              if (confirm('Delete this receipt? (Only allowed if no putaway exists)')) {
                                deleteReceiptMutation.mutate(rec.id)
                              }
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Receipt ID</span>
                <Input
                  value={receiptIdForPutaway}
                  onChange={(e) => setReceiptIdForPutaway(e.target.value)}
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
                  Load receipt lines
                </Button>
              </div>
            </div>
            {receiptQuery.isLoading && <LoadingSpinner label="Loading receipt..." />}
            {receiptQuery.isError && receiptQuery.error && (
              <Alert variant="error" title="Receipt load failed" message={(receiptQuery.error as ApiError).message} />
            )}
            {receiptQuery.data && (
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Step 4: Quality check</div>
                    <p className="text-xs text-slate-500">
                      Classify usable inventory. Remaining quantity is the maximum you can allocate to a QC event.
                    </p>
                  </div>
                </div>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Line</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Item</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Received</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Accepted</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Hold</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Reject</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Remaining</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Putaway</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {receiptQuery.data.lines?.map((line) => {
                        const qc = getQcBreakdown(line)
                        const availableQty = line.availableForNewPutaway ?? qc.accept
                        const remainingQty = line.remainingQuantityToPutaway ?? 0
                        const blockedReason = line.putawayBlockedReason ?? ''
                        const status = getQcStatus(line)
                        const itemLabel = `${line.itemSku ?? line.itemId ?? 'Item'}${line.itemName ? ` - ${line.itemName}` : ''}`
                        let putawayLabel = 'Blocked'
                        let putawayTone = 'bg-amber-100 text-amber-700'
                        if (availableQty > 0) {
                          putawayLabel = `Available ${availableQty}`
                          putawayTone = 'bg-emerald-100 text-emerald-700'
                        } else if (remainingQty > 0) {
                          putawayLabel = 'Planned in draft'
                          putawayTone = 'bg-slate-100 text-slate-600'
                        } else if (qc.accept > 0) {
                          putawayLabel = 'Putaway complete'
                          putawayTone = 'bg-slate-100 text-slate-600'
                        } else if (qc.hold > 0) {
                          putawayLabel = 'On hold'
                        } else if (qc.reject > 0) {
                          putawayLabel = 'Rejected'
                        }
                        return (
                          <tr key={line.id} className={selectedQcLineId === line.id ? 'bg-slate-50' : ''}>
                            <td className="px-3 py-2 text-sm text-slate-800">{line.id.slice(0, 8)}...</td>
                            <td className="px-3 py-2 text-sm text-slate-800">{itemLabel}</td>
                            <td className="px-3 py-2 text-sm text-slate-800">
                              {line.quantityReceived} {line.uom}
                            </td>
                            <td className="px-3 py-2 text-sm text-slate-800">{qc.accept}</td>
                            <td className="px-3 py-2 text-sm text-slate-800">{qc.hold}</td>
                            <td className="px-3 py-2 text-sm text-slate-800">{qc.reject}</td>
                            <td className="px-3 py-2 text-sm text-slate-800">{qc.remaining}</td>
                            <td className="px-3 py-2 text-sm text-slate-800">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${status.tone}`}>
                                {status.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-sm text-slate-800">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${putawayTone}`}>
                                {putawayLabel}
                              </span>
                              {blockedReason && availableQty <= 0 && (
                                <div className="mt-1 text-xs text-slate-500">{blockedReason}</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right text-sm text-slate-800">
                              <Button
                                type="button"
                                size="sm"
                                variant={selectedQcLineId === line.id ? 'primary' : 'secondary'}
                                onClick={() => setSelectedQcLineId(line.id)}
                              >
                                QC
                              </Button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {receiptQuery.data && !selectedQcLine && (
              <Alert
                variant="info"
                title="Select a line to QC"
                message="Pick a receipt line to classify accepted, hold, or rejected quantities."
              />
            )}
            {selectedQcLine && (
              <div className="rounded-lg border border-slate-200 p-3 space-y-3">
                {qcEventMutation.isError && (
                  <Alert
                    variant="error"
                    title="QC event not recorded"
                    message={
                      qcErrorMap[getErrorMessage(qcEventMutation.error, '')] ??
                      getErrorMessage(qcEventMutation.error, 'Unable to record QC event.')
                    }
                  />
                )}
                {qcEventMutation.isPending && (
                  <Alert
                    variant="info"
                    title="Recording QC event"
                    message="Updating QC totals and putaway eligibility."
                  />
                )}
                {lastQcEvent && (
                  <Alert
                    variant="success"
                    title="QC event recorded"
                    message={`${lastQcEvent.eventType === 'accept' ? 'Accepted' : lastQcEvent.eventType === 'hold' ? 'Held' : 'Rejected'} ${lastQcEvent.quantity} ${lastQcEvent.uom}.`}
                  />
                )}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">QC line detail</div>
                    <div className="text-xs text-slate-600">
                      {selectedQcLine.itemSku ?? selectedQcLine.itemId ?? 'Item'}
                      {selectedQcLine.itemName ? ` - ${selectedQcLine.itemName}` : ''}
                    </div>
                    <div className="text-xs text-slate-500">Receipt line {selectedQcLine.id.slice(0, 8)}...</div>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${getQcStatus(selectedQcLine).tone}`}>
                    {getQcStatus(selectedQcLine).label}
                  </span>
                </div>
                <div className="grid gap-2 md:grid-cols-5 text-sm text-slate-700">
                  <div>Received: {selectedQcLine.quantityReceived} {selectedQcLine.uom}</div>
                  <div>Accepted: {selectedQcStats?.accept ?? 0}</div>
                  <div>On hold: {selectedQcStats?.hold ?? 0}</div>
                  <div>Rejected: {selectedQcStats?.reject ?? 0}</div>
                  <div>Remaining: {selectedQcStats?.remaining ?? 0}</div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">Classify as</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={qcEventType === 'accept' ? 'primary' : 'secondary'}
                        onClick={() => setQcEventType('accept')}
                        disabled={qcRemaining <= 0}
                      >
                        Accept
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={qcEventType === 'hold' ? 'primary' : 'secondary'}
                        onClick={() => setQcEventType('hold')}
                        disabled={qcRemaining <= 0}
                      >
                        Hold
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={qcEventType === 'reject' ? 'primary' : 'secondary'}
                        onClick={() => setQcEventType('reject')}
                        disabled={qcRemaining <= 0}
                      >
                        Reject
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Accept makes quantity available for putaway. Hold blocks putaway. Reject removes from usable stock.
                    </p>
                    {qcRemaining <= 0 && (
                      <p className="mt-2 text-xs text-slate-500">
                        QC is complete for this line. There is no remaining quantity to classify.
                      </p>
                    )}
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Quantity (max {qcRemaining})</span>
                    <Input
                      type="number"
                      min={0}
                      max={qcRemaining}
                      value={qcQuantity}
                      onChange={(e) =>
                        setQcQuantity(e.target.value === '' ? '' : Number(e.target.value))
                      }
                      disabled={qcRemaining <= 0}
                    />
                    {qcQuantityInvalid && qcRemaining > 0 && (
                      <div className="text-xs text-amber-700">
                        Enter a quantity between 1 and {qcRemaining}.
                      </div>
                    )}
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                    <Input value={selectedQcLine.uom} disabled />
                  </label>
                </div>
                {qcEventType !== 'accept' && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Reason code (optional)</span>
                      <Input
                        value={qcReasonCode}
                        onChange={(e) => setQcReasonCode(e.target.value)}
                        placeholder="Optional reason"
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="text-xs uppercase tracking-wide text-slate-500">Notes (optional)</span>
                      <Textarea
                        value={qcNotes}
                        onChange={(e) => setQcNotes(e.target.value)}
                        placeholder="Notes for hold/reject"
                      />
                    </label>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-500">
                    Putaway: {selectedQcStats && selectedQcStats.accept > 0
                      ? `Available ${selectedPutawayAvailable} ${selectedQcLine.uom}`
                      : 'Blocked until some quantity is accepted.'}
                    {selectedQcLine?.putawayBlockedReason ? ` (${selectedQcLine.putawayBlockedReason})` : ''}
                  </div>
                  <Button type="button" size="sm" disabled={!canRecordQc} onClick={onCreateQcEvent}>
                    {qcEventMutation.isPending ? 'Recording...' : 'Record QC'}
                  </Button>
                </div>
                <div className="border-t border-slate-200 pt-3">
                  <div className="text-xs uppercase tracking-wide text-slate-500">QC events</div>
                  {qcEventsQuery.isLoading && <LoadingSpinner label="Loading QC events..." />}
                  {qcEventsQuery.isError && (
                    <div className="text-xs text-amber-700">Unable to load QC events. Try again.</div>
                  )}
                  {!qcEventsQuery.isLoading && !qcEventsQuery.isError && (qcEventsQuery.data?.data?.length ?? 0) === 0 && (
                    <div className="text-xs text-slate-500">No QC events recorded yet.</div>
                  )}
                  {!qcEventsQuery.isLoading && !qcEventsQuery.isError && (qcEventsQuery.data?.data?.length ?? 0) > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {qcEventsQuery.data?.data?.map((event) => (
                        <li key={event.id}>
                          {event.eventType.toUpperCase()} {event.quantity} {event.uom}
                          {event.reasonCode ? ` - ${event.reasonCode}` : ''}{event.notes ? ` (${event.notes})` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
            <form className="space-y-4" onSubmit={onCreatePutaway}>
              {putawayMutation.isError && (
                <Alert
                  variant="error"
                  title="Putaway draft not saved"
                  message={
                    mapErrorMessage(
                      putawayCreateErrorMap[getErrorMessage(putawayMutation.error, '')] ??
                        getErrorMessage(putawayMutation.error, ''),
                      putawayCreateErrorMap,
                    ) || 'Unable to save the putaway draft. Check the lines and try again.'
                  }
                />
              )}
              {putawayMutation.isPending && (
                <Alert
                  variant="info"
                  title="Saving putaway draft"
                  message="Planning the move. No inventory has moved yet."
                />
              )}
              {putawayMutation.isSuccess && putawayMutation.data && (
                <Alert
                  variant="success"
                  title="Putaway draft saved"
                  message={`Draft ${putawayMutation.data.id.slice(0, 8)}... created. Review the lines, then post to move inventory.`}
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
                    ) || 'Unable to post the putaway. Check the lines and try again.'
                  }
                />
              )}
              {postPutawayMutation.isPending && (
                <Alert
                  variant="warning"
                  title="Posting putaway"
                  message="Creating inventory movements. This action is irreversible."
                />
              )}
            {postPutawayMutation.isSuccess && postPutawayMutation.data && (
              <Alert
                variant="success"
                title="Putaway posted"
                message={`Inventory moved and recorded. Movement ${postPutawayMutation.data.inventoryMovementId ?? 'created'}; putaway ${postPutawayMutation.data.id.slice(0, 8)}... completed. Item → Stock is now authoritative for totals.`}
              />
            )}
              {receiptQuery.data && receiptQuery.data.lines?.some((line) => (line.qcSummary?.breakdown?.accept ?? 0) <= 0) && (
                <Alert
                  variant="warning"
                  title="QC acceptance required"
                  message="Some receipt lines have no accepted quantity yet. Accept QC quantities before planning putaway."
                />
              )}
              {putawayQcIssues.length > 0 && (
                <Alert
                  variant="warning"
                  title="Putaway blocked by QC"
                  message="Some lines have no available quantity for putaway. Accept QC or wait until pending putaways clear."
                />
              )}
              {putawayQuantityIssues.length > 0 && (
                <Alert
                  variant="warning"
                  title="Reduce putaway quantities"
                  message="One or more lines exceed the available quantity. Lower the quantities to the available amount."
                />
              )}
              {putawayFillNotice && (
                <Alert
                  variant="info"
                  title="No putaway lines added"
                  message={putawayFillNotice}
                />
              )}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Step 5: Plan putaway lines</div>
                    <p className="text-xs text-slate-500">Only accepted quantities can move.</p>
                  </div>
                  <div className="flex gap-2">
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
                </div>
              {putawayLines.map((line, idx) => (
                <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-4">
                  <div>
                    <SearchableSelect
                      label="Receipt line"
                      value={line.purchaseOrderReceiptLineId}
                      options={receiptLineOptions}
                      disabled={!receiptLineOptions.length}
                      onChange={(nextValue) => {
                        const selected = receiptLineOptions.find((opt) => opt.value === nextValue)
                        const acceptedQty = selected?.acceptedQty ?? 0
                        const availableQty = selected?.availableQty ?? acceptedQty
                        const defaults = resolvePutawayDefaults({
                          defaultFromLocationId: selected?.defaultFromLocationId,
                          defaultToLocationId: selected?.defaultToLocationId,
                        })
                        updatePutawayLine(idx, {
                          purchaseOrderReceiptLineId: nextValue,
                          uom: selected?.uom ?? line.uom,
                          quantity: availableQty > 0 ? availableQty : '',
                          toLocationId: line.toLocationId || defaults.toId,
                          fromLocationId: line.fromLocationId || defaults.fromId,
                        })
                      }}
                    />
                    {line.purchaseOrderReceiptLineId && (() => {
                      const selected = receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)
                      if (!selected) return null
                      const acceptedQty = selected.acceptedQty ?? 0
                      const availableQty = selected.availableQty ?? acceptedQty
                      const holdQty = selected.holdQty ?? 0
                      const rejectQty = selected.rejectQty ?? 0
                      const remainingQty = selected.remainingQty ?? 0
                      const tone = acceptedQty > 0 ? 'text-slate-500' : 'text-amber-700'
                      return (
                        <div className={`mt-1 text-xs ${tone}`}>
                          QC accepted {acceptedQty} · Hold {holdQty} · Reject {rejectQty} · Uninspected {remainingQty} · Available {availableQty}
                        </div>
                      )
                    })()}
                  </div>
                  <div>
                    <Combobox
                      label="To location"
                      value={line.toLocationId}
                      options={locationOptions}
                      loading={locationsQuery.isLoading}
                      onQueryChange={setLocationSearch}
                      placeholder="Search locations (code/name)"
                      onChange={(nextValue) => updatePutawayLine(idx, { toLocationId: nextValue })}
                    />
                  </div>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">From location</span>
                    <Input
                      value={line.fromLocationId}
                      onChange={(e) => updatePutawayLine(idx, { fromLocationId: e.target.value })}
                      placeholder="Defaults from receipt or item"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                    <Input value={line.uom} onChange={(e) => updatePutawayLine(idx, { uom: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Qty to move</span>
                    <Input
                      type="number"
                      min={0}
                      max={
                        line.purchaseOrderReceiptLineId
                          ? (receiptLineOptions.find((opt) => opt.value === line.purchaseOrderReceiptLineId)?.availableQty ?? undefined)
                          : undefined
                      }
                      value={line.quantity}
                      onChange={(e) =>
                        updatePutawayLine(idx, {
                          quantity: e.target.value === '' ? '' : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="submit" size="sm" disabled={!canCreatePutaway}>
                {putawayMutation.isPending ? 'Saving…' : 'Create putaway'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!putawayId || postPutawayMutation.isPending || putawayMutation.isPending}
                onClick={() => {
                  if (!putawayId) return
                  postPutawayMutation.reset()
                  postPutawayMutation.mutate(putawayId)
                }}
              >
                {postPutawayMutation.isPending ? 'Posting…' : 'Post putaway'}
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Posting creates inventory movements and cannot be undone.
            </p>
          </form>
          </div>
        </Card>
      </Section>

      {putawayQuery.data && (
        <Section title="Last putaway">
          <Card>
            <div className="text-sm text-slate-700">Status: {putawayQuery.data.status}</div>
            <div className="overflow-hidden rounded border border-slate-200 mt-2">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Line</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Receipt line</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">From → To</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {putawayQuery.data.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-sm text-slate-800">{l.lineNumber}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">{l.purchaseOrderReceiptLineId}</td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {l.fromLocationId} → {l.toLocationId}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">
                        {l.quantityPlanned} {l.uom}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-800">{l.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
      )}
    </div>
  )
}
