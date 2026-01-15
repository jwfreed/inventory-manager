import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import {
  createWorkOrderCompletion,
  postWorkOrderCompletion,
  type CompletionDraftPayload,
  updateWorkOrderDefaultsApi,
} from '../api/workOrders'
import type { ApiError, Item, WorkOrder, WorkOrderCompletion } from '@api/types'
import { PostConfirmModal } from './PostConfirmModal'
import { formatNumber } from '@shared/formatters'
import { LotAllocationsCard } from './LotAllocationsCard'
import { useLocationsList } from '@features/locations/queries'
import { useItemsList } from '@features/items/queries'
import { Combobox } from '../../../components/Combobox'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'
import { useDebouncedValue } from '@shared'

type Line = {
  outputItemId: string
  toLocationId: string
  uom: string
  quantityCompleted: number | ''
  packSize?: number
  reasonCode?: string
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  outputItem?: Item
  onRefetch: (options?: { showSummaryToast?: boolean }) => void
}

export function CompletionDraftForm({ workOrder, outputItem, onRefetch }: Props) {
  const isDisassembly = workOrder.kind === 'disassembly'
  const remaining = Math.max(
    0,
    (workOrder.quantityPlanned || 0) - (workOrder.quantityCompleted ?? 0),
  )
  const defaults = getWorkOrderDefaults(workOrder.id)
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [defaultToLocationId, setDefaultToLocationId] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([
    {
      outputItemId: isDisassembly ? '' : workOrder.outputItemId,
      toLocationId: '',
      uom: '',
      quantityCompleted: '',
      packSize: undefined,
    },
  ])
  const [createdCompletion, setCreatedCompletion] = useState<WorkOrderCompletion | null>(null)
  const [showPostConfirm, setShowPostConfirm] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  const completionMutation = useMutation<WorkOrderCompletion, ApiError, CompletionDraftPayload>({
    mutationFn: (payload) => createWorkOrderCompletion(workOrder.id, payload),
    onSuccess: (completion) => {
      setCreatedCompletion(completion)
      setWarning(null)
      void onRefetch()
    },
  })
  const defaultsMutation = useMutation({
    mutationFn: (locId: string) =>
      updateWorkOrderDefaultsApi(workOrder.id, { defaultProduceLocationId: locId || null }),
  })

  const postMutation = useMutation<WorkOrderCompletion, ApiError, { completionId: string }>({
    mutationFn: ({ completionId }) => postWorkOrderCompletion(workOrder.id, completionId),
    onSuccess: (completion) => {
      setCreatedCompletion(completion)
      setShowPostConfirm(false)
      void onRefetch({ showSummaryToast: true })
    },
  })

  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)
  const debouncedItemSearch = useDebouncedValue(itemSearch, 200)

  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )
  const itemsQuery = useItemsList(
    { limit: 200, search: debouncedItemSearch || undefined, lifecycleStatus: 'Active' },
    { staleTime: 60_000, retry: 1 },
  )

  const baseProduceLocationId =
    workOrder.defaultProduceLocationId ??
    (isDisassembly ? defaults.produceLocationId ?? '' : outputItem?.defaultLocationId ?? defaults.produceLocationId ?? '')
  const baseOutputUom = outputItem?.defaultUom || workOrder.outputUom
  const usingItemProduceDefault =
    !isDisassembly &&
    !workOrder.defaultProduceLocationId &&
    !defaults.produceLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultTo === outputItem.defaultLocationId

  useEffect(() => {
    if (!defaultToLocationId && baseProduceLocationId) {
      setDefaultToLocationId(baseProduceLocationId)
    }
  }, [baseProduceLocationId, defaultToLocationId])

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
    locationOptions.forEach((loc) => map.set(loc.value, loc.label))
    return map
  }, [locationOptions])
  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
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
  const normalizedDefaultTo = validLocationIds.has(defaultToLocationId) ? defaultToLocationId : ''
  const formatOutputLabel = (itemId: string) => {
    if (!isDisassembly && outputItem) {
      const parts = [outputItem.name, outputItem.sku].filter(Boolean)
      if (parts.length) return parts.join(' — ')
    }
    const item = itemsLookup.get(itemId)
    if (item?.name && item?.sku) return `${item.name} — ${item.sku}`
    if (item?.name) return item.name
    if (item?.sku) return item.sku
    return 'Unknown item'
  }
  const formatLocationLabel = (locationId?: string | null) => {
    if (!locationId) return 'n/a'
    return locationLookup.get(locationId) ?? 'Unknown location'
  }

  useEffect(() => {
    setLines((prev) =>
      prev.map((line) => ({
        ...line,
        toLocationId: line.toLocationId || normalizedDefaultTo || baseProduceLocationId,
        uom: line.uom || baseOutputUom,
      })),
    )
  }, [normalizedDefaultTo, baseProduceLocationId, baseOutputUom])

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      {
        outputItemId: isDisassembly ? '' : workOrder.outputItemId,
        toLocationId: normalizedDefaultTo || baseProduceLocationId,
        uom: baseOutputUom,
        quantityCompleted: '',
        packSize: undefined,
      },
    ])

  const updateLine = (index: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const onSelectDefaultToLocation = (locId: string) => {
    setDefaultToLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { produceLocationId: locId })
    defaultsMutation.mutate(locId)
    setLines((prev) =>
      prev.map((line) => ({ ...line, toLocationId: line.toLocationId || locId })),
    )
  }

  const setOutputToRemaining = () => {
    if (remaining <= 0) return
    setLines((prev) =>
      prev.map((line, index) =>
        index === 0 ? { ...line, quantityCompleted: remaining } : line,
      ),
    )
  }

  const validate = (): string | null => {
    if (lines.length === 0) return 'Add at least one line.'
    for (const line of lines) {
      if (!line.toLocationId || !line.uom || line.quantityCompleted === '') {
        return 'All line fields are required.'
      }
      if (isDisassembly && !line.outputItemId) {
        return 'Select an output item for each line.'
      }
      if (!validLocationIds.has(line.toLocationId)) return 'Select a valid production location.'
      if (Number(line.quantityCompleted) <= 0) return 'Quantities must be greater than zero.'
    }
    return null
  }

  const totalCompleted = useMemo(
    () =>
      lines.reduce((sum, line) => sum + (Number(line.quantityCompleted) || 0), 0),
    [lines],
  )

  const onSubmitDraft = () => {
    const validation = validate()
    if (validation) {
      setWarning(validation)
      return
    }
    setWarning(null)
    completionMutation.mutate({
      occurredAt: new Date(occurredAt).toISOString(),
      notes: notes || undefined,
      lines: lines.map((line) => ({
        outputItemId: isDisassembly ? line.outputItemId : workOrder.outputItemId,
        toLocationId: line.toLocationId,
        uom: line.uom,
        quantityCompleted: Number(line.quantityCompleted),
        packSize: line.packSize ? Number(line.packSize) : undefined,
        reasonCode: line.reasonCode || undefined,
        notes: line.notes,
      })),
    })
  }

  const onConfirmPost = () => {
    if (!createdCompletion) return
    postMutation.mutate({ completionId: createdCompletion.id })
  }

  const isPosted = createdCompletion?.status === 'posted'

  return (
    <Card
      title={isDisassembly ? 'Produce components' : 'Make product'}
      description={
        isDisassembly
          ? 'Record recovered components as outputs. Save a draft, then post to move inventory.'
          : 'Save a draft, then post to create the production movement.'
      }
    >
      {completionMutation.isPending && <LoadingSpinner label="Creating completion..." />}
      {postMutation.isPending && <LoadingSpinner label="Posting completion..." />}
      {warning && <Alert variant="warning" title="Fix validation" message={warning} />}
      {completionMutation.isError && (
        <Alert
          variant="error"
          title="Create failed"
          message={completionMutation.error.message}
        />
      )}
      {postMutation.isError && (
        <Alert variant="error" title="Post failed" message={postMutation.error.message} />
      )}
      {createdCompletion && (
        <Alert
          variant={isPosted ? 'success' : 'info'}
          title={isPosted ? 'Completion posted' : 'Completion draft created'}
          message={isPosted ? 'Inventory outputs recorded.' : 'Draft saved and ready to post.'}
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
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Notes
          </span>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
          />
        </label>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Lines</div>
          <div className="flex gap-2">
            {!isDisassembly && (
              <Button variant="secondary" size="sm" onClick={setOutputToRemaining} disabled={remaining <= 0}>
                Set output to remaining
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={addLine}>
              Add line
            </Button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default production location</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={normalizedDefaultTo}
              onChange={(e) => onSelectDefaultToLocation(e.target.value)}
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
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`grid gap-3 rounded-lg border border-slate-200 p-3 ${isDisassembly ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}
          >
            {isDisassembly ? (
              <div>
                <Combobox
                  label="Output item"
                  value={line.outputItemId}
                  options={itemOptions}
                  loading={itemsQuery.isLoading}
                  onQueryChange={setItemSearch}
                  placeholder="Search items (SKU/name)"
                  onChange={(nextValue) => {
                    const selected = itemsLookup.get(nextValue)
                    updateLine(idx, {
                      outputItemId: nextValue,
                      uom: line.uom || selected?.defaultUom || baseOutputUom,
                    })
                  }}
                />
              </div>
            ) : (
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Output item</span>
                <Input value={formatOutputLabel(workOrder.outputItemId)} readOnly />
              </label>
            )}
            <div>
              <Combobox
                label="To location"
                value={line.toLocationId}
                options={locationOptions}
                loading={locationsQuery.isLoading}
                onQueryChange={setLocationSearch}
                placeholder="Search locations (code/name)"
                onChange={(nextValue) => updateLine(idx, { toLocationId: nextValue })}
              />
            </div>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
              <Input value={line.uom} onChange={(e) => updateLine(idx, { uom: e.target.value })} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
              <Input
                type="number"
                min={0}
                value={line.quantityCompleted}
                onChange={(e) =>
                  updateLine(idx, {
                    quantityCompleted: e.target.value === '' ? '' : Number(e.target.value),
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
                  updateLine(idx, {
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
                  onChange={(e) => updateLine(idx, { reasonCode: e.target.value })}
                  placeholder="rework, scrap"
                />
              </label>
            )}
            <div className="flex items-start gap-2">
              <label className="flex-1 space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(e) => updateLine(idx, { notes: e.target.value })}
                />
              </label>
              {lines.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => removeLine(idx)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          Total to complete:{' '}
          <span className={totalCompleted > 0 ? 'font-semibold text-green-700' : 'font-semibold text-slate-700'}>
            {totalCompleted > 0 ? `+${formatNumber(totalCompleted)}` : formatNumber(0)}
          </span>{' '}
          {lines[0]?.uom || ''}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onSubmitDraft}
            disabled={completionMutation.isPending}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            onClick={() => setShowPostConfirm(true)}
            disabled={!createdCompletion || isPosted || postMutation.isPending}
          >
            Post completion (affects inventory)
          </Button>
        </div>
      </div>

      <PostConfirmModal
        isOpen={showPostConfirm}
        onCancel={() => setShowPostConfirm(false)}
        onConfirm={onConfirmPost}
        title="Post Completion?"
        body="Posting creates an inventory movement and cannot be edited."
        preview={
          <div className="space-y-1 text-sm text-slate-800">
            {createdCompletion?.lines.map((line) => (
              <div key={line.id} className="flex justify-between">
                <span>
                  {formatOutputLabel(line.itemId)} → {formatLocationLabel(line.toLocationId)}
                </span>
                <span className="text-green-700">
                  +{formatNumber(line.quantity)} {line.uom}
                </span>
              </div>
            ))}
          </div>
        }
      />

      {isPosted && createdCompletion?.productionMovementId && (
        <div className="mt-4">
          <LotAllocationsCard
            movementId={createdCompletion.productionMovementId}
            title="Assign lots for this completion movement"
          />
        </div>
      )}
    </Card>
  )
}
