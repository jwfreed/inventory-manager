import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import {
  getWorkOrderRequirements,
  recordWorkOrderBatch,
  updateWorkOrderDefaultsApi,
  type RecordBatchPayload,
} from '../api/workOrders'
import type { ApiError, Item, WorkOrder } from '@api/types'
import { Combobox } from '../../../components/Combobox'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'
import { useDebouncedValue } from '@shared'
import { formatNumber } from '@shared/formatters'
import { Modal } from '../../../components/Modal'

const formatError = (err: unknown): string => {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object' && 'message' in (err as { message?: unknown }) && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

type ConsumeLine = {
  componentItemId: string
  fromLocationId: string
  uom: string
  quantity: number | ''
  usesPackSize?: boolean
  reasonCode?: string
  notes?: string
}

type ProduceLine = {
  outputItemId: string
  toLocationId: string
  uom: string
  quantity: number | ''
  packSize?: number
  reasonCode?: string
  notes?: string
}

type LineFieldErrors = {
  componentItemId?: string
  outputItemId?: string
  fromLocationId?: string
  toLocationId?: string
  uom?: string
  quantity?: string
}

type StockShortageDetail = {
  itemId: string
  locationId: string
  uom: string
  requested: number
  available: number
  shortage: number
}

type Props = {
  workOrder: WorkOrder
  outputItem?: Item
  onRefetch: () => void
}

export function RecordBatchForm({ workOrder, outputItem, onRefetch }: Props) {
  const isDisassembly = workOrder.kind === 'disassembly'
  const localDefaults = getWorkOrderDefaults(workOrder.id)
  const baseOutputUom = outputItem?.defaultUom || workOrder.outputUom
  const baseConsumeLocationId =
    workOrder.defaultConsumeLocationId ??
    outputItem?.defaultLocationId ??
    localDefaults.consumeLocationId ??
    ''
  const baseProduceLocationId =
    workOrder.defaultProduceLocationId ??
    (isDisassembly ? localDefaults.produceLocationId ?? '' : outputItem?.defaultLocationId ?? localDefaults.produceLocationId ?? '')
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [applyNotesToLines, setApplyNotesToLines] = useState(false)
  const [defaultFromLocationId, setDefaultFromLocationId] = useState<string>('')
  const [defaultToLocationId, setDefaultToLocationId] = useState<string>('')
  const [packSize, setPackSize] = useState<number | ''>('')
  const remaining = Math.max(
    0,
    (workOrder.quantityPlanned || 0) - (workOrder.quantityCompleted ?? 0),
  )
  const [consumeLines, setConsumeLines] = useState<ConsumeLine[]>([
    {
      componentItemId: isDisassembly ? workOrder.outputItemId : '',
      fromLocationId: '',
      uom: baseOutputUom,
      quantity: '',
      usesPackSize: false,
    },
  ])
  const [produceLines, setProduceLines] = useState<ProduceLine[]>([
    {
      outputItemId: isDisassembly ? '' : workOrder.outputItemId,
      toLocationId: '',
      uom: baseOutputUom,
      quantity: remaining || '',
      packSize: undefined,
    },
  ])
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [lineErrors, setLineErrors] = useState<{ consume: Record<number, LineFieldErrors>; produce: Record<number, LineFieldErrors> }>({
    consume: {},
    produce: {},
  })
  const [shortageDetails, setShortageDetails] = useState<StockShortageDetail[] | null>(null)
  const [overrideAllowed, setOverrideAllowed] = useState(false)
  const [overrideRequiresReason, setOverrideRequiresReason] = useState(false)
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [successId, setSuccessId] = useState<string | null>(null)
  const [successIssueId, setSuccessIssueId] = useState<string | null>(null)
  const [successOccurredAt, setSuccessOccurredAt] = useState<string | null>(null)
  const [showOverageConfirm, setShowOverageConfirm] = useState(false)
  const [pendingPayload, setPendingPayload] = useState<RecordBatchPayload | null>(null)
  const [consumeDetailsOpen, setConsumeDetailsOpen] = useState<boolean[]>([false])
  const [produceDetailsOpen, setProduceDetailsOpen] = useState<boolean[]>([false])
  const [activeSearch, setActiveSearch] = useState<{
    type: 'item' | 'location'
    lineType: 'consume' | 'produce'
    index: number
  } | null>(null)

  const debouncedItemSearch = useDebouncedValue(activeSearch?.type === 'item' ? itemSearch : '', 200)
  const debouncedLocationSearch = useDebouncedValue(activeSearch?.type === 'location' ? locationSearch : '', 200)

  const itemsQuery = useItemsList(
    { limit: 200, search: debouncedItemSearch || undefined },
    { staleTime: 60_000, retry: 1 },
  )
  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

  const prevDefaultFromRef = useRef<string>('')
  const prevDefaultToRef = useRef<string>('')

  const itemOptions = useMemo(
    () =>
      (itemsQuery.data?.data ?? []).map((item) => ({
        value: item.id,
        label: `${item.sku} — ${item.name}`,
        keywords: `${item.sku} ${item.name}`,
      })),
    [itemsQuery.data],
  )
  const itemsLookup = useMemo(() => {
    const map = new Map<string, Item>()
    itemsQuery.data?.data?.forEach((item) => map.set(item.id, item))
    return map
  }, [itemsQuery.data])

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )
  const locationLookup = useMemo(() => {
    const map = new Map<string, string>()
    locationsQuery.data?.data?.forEach((loc) => {
      map.set(loc.id, `${loc.code} — ${loc.name}`)
    })
    return map
  }, [locationsQuery.data])
  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
  const effectiveDefaultFrom = defaultFromLocationId || baseConsumeLocationId
  const effectiveDefaultTo = defaultToLocationId || baseProduceLocationId
  const normalizedDefaultFrom = validLocationIds.has(effectiveDefaultFrom) ? effectiveDefaultFrom : ''
  const normalizedDefaultTo = validLocationIds.has(effectiveDefaultTo) ? effectiveDefaultTo : ''
  const usingItemConsumeDefault =
    !workOrder.defaultConsumeLocationId &&
    !localDefaults.consumeLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultFrom === outputItem.defaultLocationId
  const usingItemProduceDefault =
    !isDisassembly &&
    !workOrder.defaultProduceLocationId &&
    !localDefaults.produceLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultTo === outputItem.defaultLocationId

  useEffect(() => {
    setConsumeLines((prev) =>
      prev.map((line) => ({
        ...line,
        fromLocationId:
          !line.fromLocationId || line.fromLocationId === prevDefaultFromRef.current
            ? normalizedDefaultFrom
            : line.fromLocationId,
      })),
    )
    prevDefaultFromRef.current = normalizedDefaultFrom
  }, [normalizedDefaultFrom])

  useEffect(() => {
    setProduceLines((prev) =>
      prev.map((line) => ({
        ...line,
        toLocationId:
          !line.toLocationId || line.toLocationId === prevDefaultToRef.current
            ? normalizedDefaultTo
            : line.toLocationId,
      })),
    )
    prevDefaultToRef.current = normalizedDefaultTo
  }, [normalizedDefaultTo])

  const defaultsConsumeMutation = useMutation({
    mutationFn: (locId: string) =>
      updateWorkOrderDefaultsApi(workOrder.id, { defaultConsumeLocationId: locId || null }),
  })
  const defaultsProduceMutation = useMutation({
    mutationFn: (locId: string) =>
      updateWorkOrderDefaultsApi(workOrder.id, { defaultProduceLocationId: locId || null }),
  })

  const requirementsMutation = useMutation({
    mutationFn: () => getWorkOrderRequirements(workOrder.id, undefined, packSize === '' ? undefined : packSize),
    onSuccess: (req) => {
      const nextLines: ConsumeLine[] = req.lines
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((line) => ({
          componentItemId: line.componentItemId,
          fromLocationId: normalizedDefaultFrom,
          uom: line.uom,
          quantity: line.quantityRequired,
          usesPackSize: line.usesPackSize,
        }))
      setConsumeLines(nextLines.length > 0 ? nextLines : consumeLines)
      setConsumeDetailsOpen(
        Array.from({ length: nextLines.length > 0 ? nextLines.length : consumeLines.length }, () => false),
      )
      setFormErrors([])
      setLineErrors({ consume: {}, produce: {} })
    },
    onError: (err: ApiError | unknown) => {
      const message = (err as ApiError)?.message ?? 'Failed to load requirements.'
      setFormErrors([message])
    },
  })

  const recordBatchMutation = useMutation({
    mutationFn: (payload: RecordBatchPayload) => recordWorkOrderBatch(workOrder.id, payload),
    onSuccess: (result) => {
      setSuccessId(result.receiveMovementId)
      setSuccessIssueId(result.issueMovementId)
      setSuccessOccurredAt(occurredAt)
      setFormErrors([])
      setLineErrors({ consume: {}, produce: {} })
      setShortageDetails(null)
      setOverrideAllowed(false)
      setOverrideRequiresReason(false)
      setOverrideNegative(false)
      setOverrideReason('')
      void onRefetch()
    },
    onError: (err: ApiError | unknown) => {
      const apiErr = err as ApiError
      const detailPayload = apiErr?.details as { error?: any } | undefined
      const errorBody = detailPayload?.error ?? detailPayload
      if (errorBody?.code === 'INSUFFICIENT_STOCK') {
        const details = errorBody.details ?? {}
        setShortageDetails((details.lines as StockShortageDetail[]) ?? [])
        setOverrideAllowed(Boolean(details.overrideAllowed))
        setOverrideRequiresReason(Boolean(details.overrideRequiresReason))
        setFormErrors([errorBody.message ?? 'Insufficient usable stock to post this transaction.'])
        return
      }
      if (errorBody?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
        setFormErrors([errorBody.message ?? 'Override reason is required.'])
        setOverrideAllowed(true)
        setOverrideRequiresReason(true)
        return
      }
      if (errorBody?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
        setFormErrors([errorBody.message ?? 'Negative inventory override is not allowed.'])
        return
      }
      const detail =
        typeof apiErr?.details === 'object'
          ? JSON.stringify(apiErr.details)
          : typeof apiErr?.details === 'string'
            ? apiErr.details
            : ''
      const message = apiErr?.message ?? 'Failed to record batch.'
      setFormErrors([detail ? `${message}: ${detail}` : message])
    },
  })

  const addConsumeLine = () =>
    setConsumeLines((prev) => [
      ...prev,
      {
        componentItemId: isDisassembly ? workOrder.outputItemId : '',
        fromLocationId: normalizedDefaultFrom,
        uom: baseOutputUom,
        quantity: '',
        usesPackSize: false,
      },
    ])
  const addConsumeDetails = () => setConsumeDetailsOpen((prev) => [...prev, false])
  const addProduceLine = () =>
    setProduceLines((prev) => [
      ...prev,
      {
        outputItemId: isDisassembly ? '' : workOrder.outputItemId,
        toLocationId: normalizedDefaultTo,
        uom: baseOutputUom,
        quantity: '',
        packSize: undefined,
      },
    ])
  const addProduceDetails = () => setProduceDetailsOpen((prev) => [...prev, false])

  const onComponentChange = (index: number, nextValue: string) => {
    const selected = itemsLookup.get(nextValue)
    const suggestedUom = selected?.defaultUom || baseOutputUom
    setConsumeLines((prev) =>
      prev.map((line, i) =>
        i === index
          ? { ...line, componentItemId: nextValue, uom: line.uom || suggestedUom }
          : line,
      ),
    )
  }

  const updateConsumeLine = (index: number, patch: Partial<ConsumeLine>) => {
    setConsumeLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }
  const updateProduceLine = (index: number, patch: Partial<ProduceLine>) => {
    setProduceLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }
  const removeConsumeLine = (index: number) => {
    setConsumeLines((prev) => prev.filter((_, i) => i !== index))
    setConsumeDetailsOpen((prev) => prev.filter((_, i) => i !== index))
  }
  const removeProduceLine = (index: number) => {
    setProduceLines((prev) => prev.filter((_, i) => i !== index))
    setProduceDetailsOpen((prev) => prev.filter((_, i) => i !== index))
  }

  const onSelectDefaultConsume = (locId: string) => {
    setDefaultFromLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { consumeLocationId: locId })
    defaultsConsumeMutation.mutate(locId)
  }
  const onSelectDefaultProduce = (locId: string) => {
    setDefaultToLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { produceLocationId: locId })
    defaultsProduceMutation.mutate(locId)
  }

  const validate = () => {
    const nextErrors: { consume: Record<number, LineFieldErrors>; produce: Record<number, LineFieldErrors> } = {
      consume: {},
      produce: {},
    }
    const errors: string[] = []

    if (consumeLines.length === 0) {
      errors.push('Add at least one consumption line.')
    }
    if (produceLines.length === 0) {
      errors.push('Add at least one production line.')
    }

    consumeLines.forEach((line, index) => {
      const entry: LineFieldErrors = {}
      if (!line.componentItemId) entry.componentItemId = 'Select a component item.'
      if (!line.fromLocationId) entry.fromLocationId = 'Select a consume location.'
      if (!line.uom) entry.uom = 'UOM is required.'
      if (line.quantity === '') entry.quantity = 'Enter a quantity.'
      if (isDisassembly && line.componentItemId && line.componentItemId !== workOrder.outputItemId) {
        entry.componentItemId = 'Must match the disassembly input item.'
      }
      if (line.fromLocationId && !validLocationIds.has(line.fromLocationId)) {
        entry.fromLocationId = 'Select a valid consume location.'
      }
      if (line.quantity !== '' && Number(line.quantity) <= 0) {
        entry.quantity = 'Quantity must be greater than zero.'
      }
      if (Object.keys(entry).length > 0) {
        nextErrors.consume[index] = entry
      }
    })

    produceLines.forEach((line, index) => {
      const entry: LineFieldErrors = {}
      if (isDisassembly && !line.outputItemId) entry.outputItemId = 'Select an output item.'
      if (!line.toLocationId) entry.toLocationId = 'Select a production location.'
      if (!line.uom) entry.uom = 'UOM is required.'
      if (line.quantity === '') entry.quantity = 'Enter a quantity.'
      if (line.toLocationId && !validLocationIds.has(line.toLocationId)) {
        entry.toLocationId = 'Select a valid production location.'
      }
      if (line.quantity !== '' && Number(line.quantity) <= 0) {
        entry.quantity = 'Quantity must be greater than zero.'
      }
      if (Object.keys(entry).length > 0) {
        nextErrors.produce[index] = entry
      }
    })

    const errorCount =
      errors.length +
      Object.keys(nextErrors.consume).length +
      Object.keys(nextErrors.produce).length
    if (errorCount > 0 && errors.length === 0) {
      errors.push(`${errorCount} issue${errorCount === 1 ? '' : 's'} to fix.`)
    }

    return { formErrors: errors, lineErrors: nextErrors }
  }

  const inputTotals = useMemo(() => {
    const totals = new Map<string, number>()
    consumeLines.forEach((line) => {
      const key = line.uom || ''
      const qty = Number(line.quantity) || 0
      totals.set(key, (totals.get(key) ?? 0) + qty)
    })
    return Array.from(totals.entries()).filter(([uom]) => uom)
  }, [consumeLines])

  const outputTotals = useMemo(() => {
    const totals = new Map<string, number>()
    produceLines.forEach((line) => {
      const key = line.uom || ''
      const qty = Number(line.quantity) || 0
      totals.set(key, (totals.get(key) ?? 0) + qty)
    })
    return Array.from(totals.entries()).filter(([uom]) => uom)
  }, [produceLines])

  const overageRequiresConfirm = () => {
    if (isDisassembly) return false
    const remainingQty = remaining || 0
    const total = produceLines.reduce((sum, line) => {
      if (line.uom && line.uom === workOrder.outputUom) {
        return sum + (Number(line.quantity) || 0)
      }
      return sum
    }, 0)
    if (remainingQty <= 0) return total > 0
    return total > remainingQty * 1.1
  }

  const onSubmit = () => {
    setShortageDetails(null)
    const validation = validate()
    setFormErrors(validation.formErrors)
    setLineErrors(validation.lineErrors)
    if (
      validation.formErrors.length > 0 ||
      Object.keys(validation.lineErrors.consume).length > 0 ||
      Object.keys(validation.lineErrors.produce).length > 0
    ) {
      return
    }
    if (overrideNegative && overrideRequiresReason && !overrideReason.trim()) {
      setFormErrors(['Override reason is required.'])
      return
    }
    const payload: RecordBatchPayload = {
      occurredAt: new Date(occurredAt).toISOString(),
      notes: notes || undefined,
      overrideNegative: overrideNegative || undefined,
      overrideReason: overrideNegative ? overrideReason.trim() || undefined : undefined,
      consumeLines: consumeLines.map((line) => ({
        componentItemId: line.componentItemId,
        fromLocationId: line.fromLocationId,
        uom: line.uom,
        quantity: Number(line.quantity),
        reasonCode: line.reasonCode || undefined,
        notes: applyNotesToLines ? (line.notes?.trim() ? line.notes : undefined) : line.notes,
      })),
      produceLines: produceLines.map((line) => ({
        outputItemId: isDisassembly ? line.outputItemId : workOrder.outputItemId,
        toLocationId: line.toLocationId,
        uom: line.uom,
        quantity: Number(line.quantity),
        packSize: line.packSize ? Number(line.packSize) : undefined,
        reasonCode: line.reasonCode || undefined,
        notes: applyNotesToLines ? (line.notes?.trim() ? line.notes : undefined) : line.notes,
      })),
    }
    if (overageRequiresConfirm()) {
      setPendingPayload(payload)
      setShowOverageConfirm(true)
      return
    }
    recordBatchMutation.mutate(payload)
  }

  const applyConsumeLocationToAll = () => {
    if (!normalizedDefaultFrom) return
    setConsumeLines((prev) =>
      prev.map((line) => ({
        ...line,
        fromLocationId:
          !line.fromLocationId || line.fromLocationId === prevDefaultFromRef.current
            ? normalizedDefaultFrom
            : line.fromLocationId,
      })),
    )
    prevDefaultFromRef.current = normalizedDefaultFrom
  }

  const applyProduceLocationToAll = () => {
    if (!normalizedDefaultTo) return
    setProduceLines((prev) =>
      prev.map((line) => ({
        ...line,
        toLocationId:
          !line.toLocationId || line.toLocationId === prevDefaultToRef.current
            ? normalizedDefaultTo
            : line.toLocationId,
      })),
    )
    prevDefaultToRef.current = normalizedDefaultTo
  }

  const setOutputToRemaining = () => {
    if (produceLines.length === 0) return
    setProduceLines((prev) =>
      prev.map((line, index) =>
        index === 0 ? { ...line, quantity: remaining } : line,
      ),
    )
  }

  const handleItemSearch = (lineType: 'consume' | 'produce', index: number, value: string) => {
    setActiveSearch({ type: 'item', lineType, index })
    setItemSearch(value)
  }

  const handleLocationSearch = (lineType: 'consume' | 'produce', index: number, value: string) => {
    setActiveSearch({ type: 'location', lineType, index })
    setLocationSearch(value)
  }

  const submitDisabled = itemsQuery.isLoading || locationsQuery.isLoading || recordBatchMutation.isPending

  return (
    <Card title="Record batch (issue + receive)" description="Posts consumption and production in one action.">
      {(itemsQuery.isLoading || locationsQuery.isLoading || recordBatchMutation.isPending) && (
        <LoadingSpinner label="Processing..." />
      )}
      {formErrors.length > 0 && (
        <Alert variant="warning" title="Fix validation" message={formErrors.join(' ')} />
      )}
      {recordBatchMutation.isError && !shortageDetails && (
        <Alert
          variant="error"
          title="Failed to record batch"
          message={formatError(recordBatchMutation.error as ApiError)}
        />
      )}
      {shortageDetails && shortageDetails.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">Insufficient usable stock</div>
          <div className="mt-1 text-xs text-amber-800">
            One or more consume lines exceed available usable stock at the selected location.
          </div>
          <div className="mt-3 grid gap-2">
            {shortageDetails.map((line, index) => {
              const itemLabel = itemsLookup.get(line.itemId)
              const itemText = itemLabel ? `${itemLabel.sku} — ${itemLabel.name}` : line.itemId
              const locationText = locationLookup.get(line.locationId) ?? line.locationId
              return (
                <div key={`${line.itemId}-${line.locationId}-${line.uom}-${index}`} className="rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-amber-900">
                  <div className="font-semibold">{itemText}</div>
                  <div className="mt-1 text-amber-800">
                    {locationText} · {line.uom}
                  </div>
                  <div className="mt-1 text-amber-800">
                    Requested {formatNumber(line.requested)} · Available {formatNumber(line.available)} · Shortage {formatNumber(line.shortage)}
                  </div>
                </div>
              )
            })}
          </div>
          {overrideAllowed && (
            <div className="mt-3 border-t border-amber-200 pt-3">
              <label className="flex items-center gap-2 text-xs text-amber-900">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-amber-300"
                  checked={overrideNegative}
                  onChange={(event) => {
                    setOverrideNegative(event.target.checked)
                    if (!event.target.checked) {
                      setOverrideReason('')
                    }
                  }}
                />
                Allow negative inventory for this post (audited)
              </label>
              {overrideNegative && (
                <label className="mt-2 block text-xs text-amber-900">
                  <span className="font-semibold">Override reason</span>
                  <Input
                    className="mt-1"
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    placeholder="Explain why this override is necessary"
                  />
                </label>
              )}
            </div>
          )}
        </div>
      )}
      {successId && (
        <Alert
          variant="success"
          title="Batch recorded"
          message={`Movements created at ${successOccurredAt ?? occurredAt}. Issue: ${successIssueId ?? 'n/a'} · Receive: ${successId}`}
          action={
            <div className="flex gap-2">
              {successIssueId && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => window.open(`/movements/${successIssueId}`, '_blank')}
                >
                  View issue movement
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => window.open(`/movements/${successId}`, '_blank')}
              >
                View receive movement
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSuccessId(null)
                  setSuccessIssueId(null)
                  setSuccessOccurredAt(null)
                  setOccurredAt(new Date().toISOString().slice(0, 16))
                }}
              >
                Record another batch
              </Button>
            </div>
          }
        />
      )}

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Batch summary</div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <span>Planned: {formatNumber(workOrder.quantityPlanned)} {workOrder.outputUom}</span>
          <span>Completed: {formatNumber(workOrder.quantityCompleted ?? 0)} {workOrder.outputUom}</span>
          <span className="font-semibold text-slate-900">Remaining: {formatNumber(remaining)} {workOrder.outputUom}</span>
          {!isDisassembly && (
            <Button size="sm" variant="secondary" onClick={setOutputToRemaining}>
              Set output qty to remaining
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6">
        <div className="text-sm font-semibold text-slate-800">1) Batch metadata</div>
        <div className="text-xs text-slate-500">Set the timestamp and optional batch notes.</div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Occurred at
          </span>
          <Input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</span>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
          />
        </label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300"
          checked={applyNotesToLines}
          onChange={(e) => setApplyNotesToLines(e.target.checked)}
        />
        Apply batch notes to lines unless a line note is specified.
      </label>

      <div className="mt-8 space-y-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">2) Consumption</div>
          <div className="text-xs text-slate-500">Record the inputs consumed for this batch.</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <span>Pack size</span>
              <Input
                type="number"
                min={0}
                className="w-24"
                value={packSize}
                onChange={(e) => setPackSize(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </label>
            {!isDisassembly && (
              <Button variant="secondary" size="sm" onClick={() => requirementsMutation.mutate()}>
                {requirementsMutation.isPending ? 'Loading…' : 'Load from BOM'}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                addConsumeLine()
                addConsumeDetails()
              }}
            >
              Add consume line
            </Button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default consume location</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={normalizedDefaultFrom}
              onChange={(e) => onSelectDefaultConsume(e.target.value)}
              disabled={locationsQuery.isLoading}
            >
              <option value="">Select location</option>
              {locationOptions.map((loc) => (
                <option key={loc.value} value={loc.value}>
                  {loc.label}
                </option>
              ))}
            </select>
            {usingItemConsumeDefault && (
              <p className="text-xs text-slate-500">Auto from item default location</p>
            )}
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={applyConsumeLocationToAll}
                disabled={!normalizedDefaultFrom}
              >
                Apply to all consume lines
              </Button>
            </div>
          </label>
        </div>
        {consumeLines.map((line, idx) => (
          <div key={idx} className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Line {idx + 1}</div>
              {consumeLines.length > 1 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => removeConsumeLine(idx)}
                >
                  Remove
                </Button>
              )}
            </div>
            <div className={`grid gap-3 ${isDisassembly ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}>
              <div>
                <Combobox
                  label={isDisassembly ? 'Input item' : 'Component item'}
                  value={line.componentItemId}
                  options={itemOptions}
                  loading={itemsQuery.isLoading}
                  onQueryChange={(value) => handleItemSearch('consume', idx, value)}
                  placeholder="Search items (SKU/name)"
                  onChange={(nextValue) => onComponentChange(idx, nextValue)}
                />
                {line.usesPackSize && (
                  <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Pack-size driven
                  </div>
                )}
                {lineErrors.consume[idx]?.componentItemId && (
                  <div className="text-xs text-red-600">{lineErrors.consume[idx]?.componentItemId}</div>
                )}
              </div>
              <div>
                <Combobox
                  label="From location"
                  value={line.fromLocationId}
                  options={locationOptions}
                  loading={locationsQuery.isLoading}
                  onQueryChange={(value) => handleLocationSearch('consume', idx, value)}
                  placeholder="Search locations (code/name)"
                  onChange={(nextValue) => updateConsumeLine(idx, { fromLocationId: nextValue })}
                />
                {lineErrors.consume[idx]?.fromLocationId && (
                  <div className="text-xs text-red-600">{lineErrors.consume[idx]?.fromLocationId}</div>
                )}
              </div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                <Input value={line.uom} onChange={(e) => updateConsumeLine(idx, { uom: e.target.value })} />
                {lineErrors.consume[idx]?.uom && (
                  <div className="text-xs text-red-600">{lineErrors.consume[idx]?.uom}</div>
                )}
                {line.componentItemId && itemsLookup.get(line.componentItemId)?.defaultUom && line.uom !== itemsLookup.get(line.componentItemId)?.defaultUom && (
                  <div className="text-xs text-slate-500">
                    Default UOM for this item is {itemsLookup.get(line.componentItemId)?.defaultUom}
                  </div>
                )}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
                <Input
                  type="number"
                  min={0}
                  value={line.quantity}
                  onChange={(e) =>
                    updateConsumeLine(idx, {
                      quantity: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                />
                {lineErrors.consume[idx]?.quantity && (
                  <div className="text-xs text-red-600">{lineErrors.consume[idx]?.quantity}</div>
                )}
              </label>
              {isDisassembly && (
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
                  <Input
                    value={line.reasonCode || ''}
                    onChange={(e) => updateConsumeLine(idx, { reasonCode: e.target.value })}
                    placeholder="breakage, rework"
                  />
                </label>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setConsumeDetailsOpen((prev) =>
                    prev.map((open, i) => (i === idx ? !open : open)),
                  )
                }
              >
                {consumeDetailsOpen[idx] ? 'Hide details' : 'Details'}
              </Button>
              {consumeDetailsOpen[idx] && (
                <label className="flex-1 space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                  <Textarea
                    value={line.notes || ''}
                    onChange={(e) => updateConsumeLine(idx, { notes: e.target.value })}
                  />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">
            3) {isDisassembly ? 'Outputs' : 'Production'}
          </div>
          <div className="text-xs text-slate-500">Record the outputs produced for this batch.</div>
        </div>
        <div className="flex items-center justify-between">
          <div />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              addProduceLine()
              addProduceDetails()
            }}
          >
            {isDisassembly ? 'Add output line' : 'Add production line'}
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default production location</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={normalizedDefaultTo}
              onChange={(e) => onSelectDefaultProduce(e.target.value)}
              disabled={locationsQuery.isLoading}
            >
              <option value="">Select location</option>
              {locationOptions.map((loc) => (
                <option key={loc.value} value={loc.value}>
                  {loc.label}
                </option>
              ))}
            </select>
            {usingItemProduceDefault && (
              <p className="text-xs text-slate-500">Auto from item default location</p>
            )}
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={applyProduceLocationToAll}
                disabled={!normalizedDefaultTo}
              >
                Apply to all output lines
              </Button>
            </div>
          </label>
        </div>
        {produceLines.map((line, idx) => (
          <div key={idx} className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Line {idx + 1}</div>
              {produceLines.length > 1 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => removeProduceLine(idx)}
                >
                  Remove
                </Button>
              )}
            </div>
            <div className={`grid gap-3 ${isDisassembly ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}>
              {isDisassembly ? (
                <div>
                  <Combobox
                    label="Output item"
                    value={line.outputItemId}
                    options={itemOptions}
                    loading={itemsQuery.isLoading}
                    onQueryChange={(value) => handleItemSearch('produce', idx, value)}
                    placeholder="Search items (SKU/name)"
                    onChange={(nextValue) => {
                      const selected = itemsLookup.get(nextValue)
                      updateProduceLine(idx, {
                        outputItemId: nextValue,
                        uom: line.uom || selected?.defaultUom || baseOutputUom,
                      })
                    }}
                  />
                  {lineErrors.produce[idx]?.outputItemId && (
                    <div className="text-xs text-red-600">{lineErrors.produce[idx]?.outputItemId}</div>
                  )}
                </div>
            ) : (
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Output item</span>
                <Input
                  value={
                    outputItem
                      ? `${outputItem.name} — ${outputItem.sku}`
                      : workOrder.outputItemName || workOrder.outputItemSku || workOrder.outputItemId
                  }
                  readOnly
                />
              </label>
            )}
              <div>
                <Combobox
                  label="To location"
                  value={line.toLocationId}
                  options={locationOptions}
                  loading={locationsQuery.isLoading}
                  onQueryChange={(value) => handleLocationSearch('produce', idx, value)}
                  placeholder="Search locations (code/name)"
                  onChange={(nextValue) => updateProduceLine(idx, { toLocationId: nextValue })}
                />
                {lineErrors.produce[idx]?.toLocationId && (
                  <div className="text-xs text-red-600">{lineErrors.produce[idx]?.toLocationId}</div>
                )}
              </div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                <Input value={line.uom} onChange={(e) => updateProduceLine(idx, { uom: e.target.value })} />
                {lineErrors.produce[idx]?.uom && (
                  <div className="text-xs text-red-600">{lineErrors.produce[idx]?.uom}</div>
                )}
                {line.outputItemId && itemsLookup.get(line.outputItemId)?.defaultUom && line.uom !== itemsLookup.get(line.outputItemId)?.defaultUom && (
                  <div className="text-xs text-slate-500">
                    Default UOM for this item is {itemsLookup.get(line.outputItemId)?.defaultUom}
                  </div>
                )}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
                <Input
                  type="number"
                  min={0}
                  value={line.quantity}
                  onChange={(e) =>
                    updateProduceLine(idx, {
                      quantity: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                />
                {lineErrors.produce[idx]?.quantity && (
                  <div className="text-xs text-red-600">{lineErrors.produce[idx]?.quantity}</div>
                )}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Pack size (bars per box)</span>
                <Input
                  type="number"
                  min={0}
                  value={line.packSize ?? ''}
                  onChange={(e) =>
                    updateProduceLine(idx, {
                      packSize: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                />
              </label>
              {isDisassembly && (
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
                  <Input
                    value={line.reasonCode || ''}
                    onChange={(e) => updateProduceLine(idx, { reasonCode: e.target.value })}
                    placeholder="rework, scrap"
                  />
                </label>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setProduceDetailsOpen((prev) =>
                    prev.map((open, i) => (i === idx ? !open : open)),
                  )
                }
              >
                {produceDetailsOpen[idx] ? 'Hide details' : 'Details'}
              </Button>
              {produceDetailsOpen[idx] && (
                <label className="flex-1 space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                  <Textarea
                    value={line.notes || ''}
                    onChange={(e) => updateProduceLine(idx, { notes: e.target.value })}
                  />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>

      {isDisassembly && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Yield preview</div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <div>
              <div className="text-xs text-slate-500">Inputs</div>
              {inputTotals.length === 0 ? (
                <div className="text-sm text-slate-600">Add input quantities to preview.</div>
              ) : (
                <div className="text-sm text-slate-800">
                  {inputTotals.map(([uom, qty]) => (
                    <span key={`input-${uom}`} className="mr-3">
                      {formatNumber(qty)} {uom}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-slate-500">Outputs</div>
              {outputTotals.length === 0 ? (
                <div className="text-sm text-slate-600">Add output quantities to preview.</div>
              ) : (
                <div className="text-sm text-slate-800">
                  {outputTotals.map(([uom, qty]) => (
                    <span key={`output-${uom}`} className="mr-3">
                      {formatNumber(qty)} {uom}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Posting preview</div>
        <div className="mt-2">Will post 1 issue movement and 1 receive movement.</div>
        <div className="mt-2">
          <div className="text-xs text-slate-500">Issue totals</div>
          {inputTotals.length === 0 ? (
            <div className="text-sm text-slate-600">Add input quantities to preview.</div>
          ) : (
            <div className="text-sm text-slate-800">
              {inputTotals.map(([uom, qty]) => (
                <span key={`issue-${uom}`} className="mr-3">
                  {formatNumber(qty)} {uom}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2">
          <div className="text-xs text-slate-500">Receive totals</div>
          {outputTotals.length === 0 ? (
            <div className="text-sm text-slate-600">Add output quantities to preview.</div>
          ) : (
            <div className="text-sm text-slate-800">
              {outputTotals.map(([uom, qty]) => (
                <span key={`receive-${uom}`} className="mr-3">
                  {formatNumber(qty)} {uom}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          This will create one issue movement and one receive movement atomically.
        </div>
        <Button onClick={onSubmit} disabled={submitDisabled}>
          Record batch
        </Button>
      </div>

      <Modal
        isOpen={showOverageConfirm}
        onClose={() => setShowOverageConfirm(false)}
        title="Record beyond remaining?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowOverageConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!pendingPayload) return
                setShowOverageConfirm(false)
                recordBatchMutation.mutate(pendingPayload)
                setPendingPayload(null)
              }}
            >
              Continue
            </Button>
          </div>
        }
      >
        <div className="text-sm text-slate-700">
          You are recording more than the remaining planned quantity. Continue anyway?
        </div>
      </Modal>
    </Card>
  )
}
