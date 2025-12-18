import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import { listItems } from '../../../api/endpoints/items'
import { listLocations } from '../../../api/endpoints/locations'
import {
  getWorkOrderRequirements,
  recordWorkOrderBatch,
  updateWorkOrderDefaultsApi,
  type RecordBatchPayload,
} from '../../../api/endpoints/workOrders'
import type { ApiError, Item, Location, WorkOrder } from '../../../api/types'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'

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
  notes?: string
}

type ProduceLine = {
  outputItemId: string
  toLocationId: string
  uom: string
  quantity: number | ''
  packSize?: number
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  outputItem?: Item
  onRefetch: () => void
}

export function RecordBatchForm({ workOrder, outputItem, onRefetch }: Props) {
  const localDefaults = getWorkOrderDefaults(workOrder.id)
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [defaultFromLocationId, setDefaultFromLocationId] = useState<string>('')
  const [defaultToLocationId, setDefaultToLocationId] = useState<string>('')
  const [packSize, setPackSize] = useState<number | ''>('')
  const remaining = Math.max(
    0,
    (workOrder.quantityPlanned || 0) - (workOrder.quantityCompleted ?? 0),
  )
  const [consumeLines, setConsumeLines] = useState<ConsumeLine[]>([
    { componentItemId: '', fromLocationId: '', uom: '', quantity: '', usesPackSize: false },
  ])
  const [produceLines, setProduceLines] = useState<ProduceLine[]>([
    {
      outputItemId: workOrder.outputItemId,
      toLocationId: '',
      uom: '',
      quantity: remaining || '',
      packSize: undefined,
    },
  ])
  const [warning, setWarning] = useState<string | null>(null)
  const [successId, setSuccessId] = useState<string | null>(null)
  const [successIssueId, setSuccessIssueId] = useState<string | null>(null)

  const itemsQuery = useQuery<{ data: Item[] }, ApiError>({
    queryKey: ['items', 'wo-batch', itemSearch],
    queryFn: () => listItems({ limit: 200, search: itemSearch || undefined }),
    staleTime: 60_000,
    retry: 1,
  })
  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'wo-batch', locationSearch],
    queryFn: () => listLocations({ limit: 200, search: locationSearch || undefined, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const baseConsumeLocationId =
    workOrder.defaultConsumeLocationId ??
    outputItem?.defaultLocationId ??
    localDefaults.consumeLocationId ??
    ''
  const baseProduceLocationId =
    workOrder.defaultProduceLocationId ??
    outputItem?.defaultLocationId ??
    localDefaults.produceLocationId ??
    ''
  const baseOutputUom = outputItem?.defaultUom || workOrder.outputUom
  const usingItemConsumeDefault =
    !workOrder.defaultConsumeLocationId &&
    !localDefaults.consumeLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultFrom === outputItem.defaultLocationId
  const usingItemProduceDefault =
    !workOrder.defaultProduceLocationId &&
    !localDefaults.produceLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultTo === outputItem.defaultLocationId

  useEffect(() => {
    if (!defaultFromLocationId && baseConsumeLocationId) {
      setDefaultFromLocationId(baseConsumeLocationId)
    }
  }, [baseConsumeLocationId, defaultFromLocationId])

  useEffect(() => {
    if (!defaultToLocationId && baseProduceLocationId) {
      setDefaultToLocationId(baseProduceLocationId)
    }
  }, [baseProduceLocationId, defaultToLocationId])

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
  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
  const effectiveDefaultFrom = defaultFromLocationId || baseConsumeLocationId
  const effectiveDefaultTo = defaultToLocationId || baseProduceLocationId
  const normalizedDefaultFrom = validLocationIds.has(effectiveDefaultFrom) ? effectiveDefaultFrom : ''
  const normalizedDefaultTo = validLocationIds.has(effectiveDefaultTo) ? effectiveDefaultTo : ''

  useEffect(() => {
    setConsumeLines((prev) =>
      prev.map((line) => ({
        ...line,
        fromLocationId: line.fromLocationId || effectiveDefaultFrom,
        uom: line.uom || baseOutputUom,
      })),
    )
  }, [effectiveDefaultFrom, baseOutputUom])

  useEffect(() => {
    setProduceLines((prev) =>
      prev.map((line) => ({
        ...line,
        toLocationId: line.toLocationId || effectiveDefaultTo,
        uom: line.uom || baseOutputUom,
      })),
    )
  }, [effectiveDefaultTo, baseOutputUom])

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
          fromLocationId: effectiveDefaultFrom,
          uom: line.uom,
          quantity: line.quantityRequired,
          usesPackSize: line.usesPackSize,
        }))
      setConsumeLines(nextLines.length > 0 ? nextLines : consumeLines)
      setWarning(null)
    },
    onError: (err: ApiError | unknown) => {
      const message = (err as ApiError)?.message ?? 'Failed to load requirements.'
      setWarning(message)
    },
  })

  const recordBatchMutation = useMutation({
    mutationFn: (payload: RecordBatchPayload) => recordWorkOrderBatch(workOrder.id, payload),
    onSuccess: (result) => {
      setSuccessId(result.receiveMovementId)
      setSuccessIssueId(result.issueMovementId)
      setWarning(null)
      void onRefetch()
    },
    onError: (err: ApiError | unknown) => {
      const apiErr = err as ApiError
      const detail =
        typeof apiErr?.details === 'object'
          ? JSON.stringify(apiErr.details)
          : typeof apiErr?.details === 'string'
            ? apiErr.details
            : ''
      const message = apiErr?.message ?? 'Failed to record batch.'
      setWarning(detail ? `${message}: ${detail}` : message)
    },
  })

  const addConsumeLine = () =>
    setConsumeLines((prev) => [
      ...prev,
      { componentItemId: '', fromLocationId: normalizedDefaultFrom, uom: baseOutputUom, quantity: '', usesPackSize: false },
    ])
  const addProduceLine = () =>
    setProduceLines((prev) => [
      ...prev,
      {
        outputItemId: workOrder.outputItemId,
        toLocationId: normalizedDefaultTo,
        uom: baseOutputUom,
        quantity: '',
        packSize: undefined,
      },
    ])

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
  const removeConsumeLine = (index: number) => setConsumeLines((prev) => prev.filter((_, i) => i !== index))
  const removeProduceLine = (index: number) => setProduceLines((prev) => prev.filter((_, i) => i !== index))

  const onSelectDefaultConsume = (locId: string) => {
    setDefaultFromLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { consumeLocationId: locId })
    defaultsConsumeMutation.mutate(locId)
    setConsumeLines((prev) =>
      prev.map((line) => ({ ...line, fromLocationId: line.fromLocationId || locId })),
    )
  }
  const onSelectDefaultProduce = (locId: string) => {
    setDefaultToLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { produceLocationId: locId })
    defaultsProduceMutation.mutate(locId)
    setProduceLines((prev) =>
      prev.map((line) => ({ ...line, toLocationId: line.toLocationId || locId })),
    )
  }

  const validate = (): string | null => {
    if (consumeLines.length === 0) return 'Add at least one consumption line.'
    if (produceLines.length === 0) return 'Add at least one production line.'
    for (const line of consumeLines) {
      if (!line.componentItemId || !line.fromLocationId || !line.uom || line.quantity === '') {
        return 'All consumption line fields are required.'
      }
      if (!validLocationIds.has(line.fromLocationId)) return 'Select a valid consume location.'
      if (Number(line.quantity) <= 0) return 'Consumption quantities must be greater than zero.'
    }
    for (const line of produceLines) {
      if (!line.toLocationId || !line.uom || line.quantity === '') {
        return 'All production line fields are required.'
      }
      if (!validLocationIds.has(line.toLocationId)) return 'Select a valid production location.'
      if (Number(line.quantity) <= 0) return 'Production quantities must be greater than zero.'
    }
    return null
  }

  const onSubmit = () => {
    const validation = validate()
    if (validation) {
      setWarning(validation)
      return
    }
    setWarning(null)
    const payload: RecordBatchPayload = {
      occurredAt: new Date(occurredAt).toISOString(),
      notes: notes || undefined,
      consumeLines: consumeLines.map((line) => ({
        componentItemId: line.componentItemId,
        fromLocationId: line.fromLocationId,
        uom: line.uom,
        quantity: Number(line.quantity),
        notes: line.notes,
      })),
      produceLines: produceLines.map((line) => ({
        outputItemId: workOrder.outputItemId,
        toLocationId: line.toLocationId,
        uom: line.uom,
        quantity: Number(line.quantity),
        packSize: line.packSize ? Number(line.packSize) : undefined,
        notes: line.notes,
      })),
    }
    recordBatchMutation.mutate(payload)
  }

  return (
    <Card title="Record batch (issue + receive)" description="Posts consumption and production in one action.">
      {(itemsQuery.isLoading || locationsQuery.isLoading || recordBatchMutation.isPending) && (
        <LoadingSpinner label="Processing..." />
      )}
      {warning && <Alert variant="warning" title="Fix validation" message={warning} />}
      {recordBatchMutation.isError && (
        <Alert
          variant="error"
          title="Failed to record batch"
          message={formatError(recordBatchMutation.error as ApiError)}
        />
      )}
      {successId && (
        <Alert
          variant="success"
          title="Batch recorded"
          message={`Movements created. Issue: ${successIssueId ?? 'n/a'} · Receive: ${successId}`}
          action={
            <div className="flex gap-2">
              {successIssueId && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => window.open(`/ledger/movements/${successIssueId}`, '_blank')}
                >
                  View issue movement
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => window.open(`/ledger/movements/${successId}`, '_blank')}
              >
                View receive movement
              </Button>
            </div>
          }
        />
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
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

      <div className="mt-6 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Consumption</div>
          <div className="flex gap-2">
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
            <Button variant="secondary" size="sm" onClick={() => requirementsMutation.mutate()}>
              {requirementsMutation.isPending ? 'Loading…' : 'Load from BOM'}
            </Button>
            <Button variant="secondary" size="sm" onClick={addConsumeLine}>
              Add consume line
            </Button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Item search</span>
            <Input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search items (SKU/name)"
            />
          </label>
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
          </label>
        </div>
        {consumeLines.map((line, idx) => (
          <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5">
            <div>
              <SearchableSelect
                label="Component item"
                value={line.componentItemId}
                options={itemOptions}
                disabled={itemsQuery.isLoading}
                onChange={(nextValue) => onComponentChange(idx, nextValue)}
              />
              {line.usesPackSize && (
                <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Pack-size driven
                </div>
              )}
            </div>
            <div>
              <SearchableSelect
                label="From location"
                value={line.fromLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading}
                onChange={(nextValue) => updateConsumeLine(idx, { fromLocationId: nextValue })}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input value={line.uom} onChange={(e) => updateConsumeLine(idx, { uom: e.target.value })} />
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
            </label>
            <div className="flex items-start gap-2">
              <label className="flex-1 space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(e) => updateConsumeLine(idx, { notes: e.target.value })}
                />
              </label>
              {consumeLines.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => removeConsumeLine(idx)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Production</div>
          <Button variant="secondary" size="sm" onClick={addProduceLine}>
            Add production line
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Location search</span>
            <Input
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
              placeholder="Search locations (code/name)"
            />
          </label>
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
          </label>
        </div>
        {produceLines.map((line, idx) => (
          <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5">
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Output Item ID</span>
              <Input value={workOrder.outputItemId} readOnly />
            </label>
            <div>
              <SearchableSelect
                label="To location"
                value={line.toLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading}
                onChange={(nextValue) => updateProduceLine(idx, { toLocationId: nextValue })}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input value={line.uom} onChange={(e) => updateProduceLine(idx, { uom: e.target.value })} />
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
            <div className="flex items-start gap-2">
              <label className="flex-1 space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(e) => updateProduceLine(idx, { notes: e.target.value })}
                />
              </label>
              {produceLines.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => removeProduceLine(idx)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          This will create one issue movement and one receive movement atomically.
        </div>
        <Button onClick={onSubmit} disabled={recordBatchMutation.isPending}>
          Record batch
        </Button>
      </div>
    </Card>
  )
}
