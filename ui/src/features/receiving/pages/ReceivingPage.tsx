import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { listPurchaseOrders, getPurchaseOrder } from '../../../api/endpoints/purchaseOrders'
import { createReceipt, type ReceiptCreatePayload, getReceipt, listReceipts, deleteReceiptApi } from '../../../api/endpoints/receipts'
import { createPutaway, postPutaway, type PutawayCreatePayload, getPutaway } from '../../../api/endpoints/putaways'
import type { ApiError, Location, PurchaseOrder, PurchaseOrderReceipt, Putaway } from '../../../api/types'
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
  const [searchParams] = useSearchParams()
  const [selectedPoId, setSelectedPoId] = useState('')
  const [receiptLineInputs, setReceiptLineInputs] = useState<ReceiptLineInput[]>([])
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receivedToLocationId, setReceivedToLocationId] = useState('')
  const [receiptIdForPutaway, setReceiptIdForPutaway] = useState('')
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

  const receiptLineOptions = useMemo(
    () =>
      (receiptQuery.data?.lines ?? []).map((line) => ({
        value: line.id,
        label: `Line ${line.id.slice(0, 8)}… — ${line.itemSku ?? line.itemId ?? 'Item'}${line.itemName ? ` — ${line.itemName}` : ''} · ${line.quantityReceived} ${line.uom}`,
        uom: line.uom,
        quantity: line.quantityReceived,
        defaultToLocationId: line.defaultToLocationId ?? '',
        defaultFromLocationId: line.defaultFromLocationId ?? receiptQuery.data?.receivedToLocationId ?? '',
      })),
    [receiptQuery.data],
  )

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
    setPutawayLines(
      lines.map((l) => ({
        purchaseOrderReceiptLineId: l.id,
        ...(() => {
          const defaults = resolvePutawayDefaults({
            defaultFromLocationId: l.defaultFromLocationId ?? receiptQuery.data?.receivedToLocationId ?? '',
            defaultToLocationId: l.defaultToLocationId ?? '',
          })
          return { toLocationId: defaults.toId, fromLocationId: defaults.fromId }
        })(),
        uom: l.uom,
        quantity: l.quantityReceived,
      })),
    )
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
                message={`Receipt ${receiptMutation.data.id.slice(0, 8)}… posted. Inventory is updated. Next: create a putaway when you're ready.`}
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
        title="Move received items to storage"
        description="Step 4: decide where received inventory goes. Putaway can be immediate or deferred."
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
                message={`Draft ${putawayMutation.data.id.slice(0, 8)}… created. Review the lines, then post to move inventory.`}
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
                message={`Inventory moved and recorded. Movement ${postPutawayMutation.data.inventoryMovementId ?? 'created'}; putaway ${postPutawayMutation.data.id.slice(0, 8)}… completed.`}
              />
            )}
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
                <div className="text-sm font-semibold text-slate-800">Receipt lines</div>
                <div className="overflow-hidden rounded border border-slate-200 mt-2">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Line ID</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">PO Line</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Qty received</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">UOM</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {receiptQuery.data.lines?.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 text-sm text-slate-800">{l.id}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{l.purchaseOrderLineId}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{l.quantityReceived}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{l.uom}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">Putaway lines</div>
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
                        const defaults = resolvePutawayDefaults({
                          defaultFromLocationId: selected?.defaultFromLocationId,
                          defaultToLocationId: selected?.defaultToLocationId,
                        })
                        updatePutawayLine(idx, {
                          purchaseOrderReceiptLineId: nextValue,
                          uom: selected?.uom ?? line.uom,
                          quantity: selected?.quantity ?? line.quantity,
                          toLocationId: line.toLocationId || defaults.toId,
                          fromLocationId: line.fromLocationId || defaults.fromId,
                        })
                      }}
                    />
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
              <Button type="submit" size="sm" disabled={putawayMutation.isPending}>
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
