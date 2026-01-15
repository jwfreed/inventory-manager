import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import {
  createWorkOrderIssue,
  getWorkOrderRequirements,
  updateWorkOrderDefaultsApi,
  postWorkOrderIssue,
  type IssueDraftPayload,
} from '../api/workOrders'
import { itemsQueryKeys, useItemsList } from '@features/items/queries'
import { getItemInventorySummary } from '@features/items/api/items'
import { useLocationsList } from '@features/locations/queries'
import type { ApiError, Item, ItemInventoryRow, WorkOrder, WorkOrderIssue } from '@api/types'
import { PostConfirmModal } from './PostConfirmModal'
import { formatNumber } from '@shared/formatters'
import { LotAllocationsCard } from './LotAllocationsCard'
import { Combobox } from '../../../components/Combobox'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'
import { useDebouncedValue } from '@shared'
import { getAtp } from '@api/reports'
import type { AtpResult } from '@api/types'

type Line = {
  componentItemId: string
  fromLocationId: string
  uom: string
  quantityIssued: number | ''
  reasonCode?: string
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  outputItem?: Item
  onRefetch: (options?: { showSummaryToast?: boolean }) => void
}

export function IssueDraftForm({ workOrder, outputItem, onRefetch }: Props) {
  const isDisassembly = workOrder.kind === 'disassembly'
  const localDefaults = getWorkOrderDefaults(workOrder.id)
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [defaultFromLocationId, setDefaultFromLocationId] = useState<string>('')
  const [lines, setLines] = useState<Line[]>([
    {
      componentItemId: isDisassembly ? workOrder.outputItemId : '',
      fromLocationId: '',
      uom: '',
      quantityIssued: '',
    },
  ])
  const [createdIssue, setCreatedIssue] = useState<WorkOrderIssue | null>(null)
  const [showPostConfirm, setShowPostConfirm] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)

  const issueMutation = useMutation<WorkOrderIssue, ApiError, IssueDraftPayload>({
    mutationFn: (payload) => createWorkOrderIssue(workOrder.id, payload),
    onSuccess: (issue) => {
      setCreatedIssue(issue)
      setWarning(null)
      void onRefetch()
    },
  })

  const postMutation = useMutation<WorkOrderIssue, ApiError, { issueId: string }>({
    mutationFn: ({ issueId }) => postWorkOrderIssue(workOrder.id, issueId),
    onSuccess: (issue) => {
      setCreatedIssue(issue)
      setShowPostConfirm(false)
      void onRefetch({ showSummaryToast: true })
    },
  })

  const defaultsMutation = useMutation({
    mutationFn: (locId: string) =>
      updateWorkOrderDefaultsApi(workOrder.id, { defaultConsumeLocationId: locId || null }),
    onSuccess: () => {
      // noop
    },
  })

  const requirementsMutation = useMutation({
    mutationFn: () => getWorkOrderRequirements(workOrder.id),
    onSuccess: (req) => {
      const nextLines: Line[] = req.lines
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((line) => {
          const component = itemsLookup.get(line.componentItemId)
          const componentLocation = component?.defaultLocationId || ''
          return {
            componentItemId: line.componentItemId,
            fromLocationId: componentLocation || effectiveDefaultFrom,
            uom: line.uom,
            quantityIssued: line.quantityRequired,
          }
        })
      setLines(
        nextLines.length > 0
          ? nextLines
          : [
              {
                componentItemId: '',
                fromLocationId: effectiveDefaultFrom,
                uom: baseOutputUom,
                quantityIssued: '',
              },
            ],
      )
      setWarning(null)
    },
    onError: (err: ApiError | unknown) => {
      const message = (err as ApiError)?.message ?? 'Failed to load requirements.'
      setWarning(message)
    },
  })

  const debouncedItemSearch = useDebouncedValue(itemSearch, 200)
  const debouncedLocationSearch = useDebouncedValue(locationSearch, 200)

  const itemsQuery = useItemsList(
    { limit: 200, search: debouncedItemSearch || undefined, lifecycleStatus: 'Active' },
    { staleTime: 60_000, retry: 1 },
  )

  const locationsQuery = useLocationsList(
    { limit: 200, search: debouncedLocationSearch || undefined, active: true },
    { staleTime: 60_000, retry: 1 },
  )

  const baseConsumeLocationId =
    workOrder.defaultConsumeLocationId ??
    outputItem?.defaultLocationId ??
    localDefaults.consumeLocationId ??
    ''
  const baseOutputUom = outputItem?.defaultUom || workOrder.outputUom

  useEffect(() => {
    if (!defaultFromLocationId && baseConsumeLocationId) {
      setDefaultFromLocationId(baseConsumeLocationId)
    }
  }, [baseConsumeLocationId, defaultFromLocationId])

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

  const availabilityItemIds = useMemo(
    () => Array.from(new Set(lines.map((line) => line.componentItemId).filter(Boolean))),
    [lines],
  )

  const availabilityQueries = useQueries({
    queries: availabilityItemIds.map((itemId) => ({
      queryKey: itemsQueryKeys.inventorySummary(itemId),
      queryFn: () => getItemInventorySummary(itemId),
      enabled: Boolean(itemId),
      staleTime: 30_000,
      retry: 1,
    })),
  })

  const availabilityByItem = useMemo(() => {
    const map = new Map<string, { rows: ItemInventoryRow[]; isLoading: boolean; isError: boolean }>()
    availabilityItemIds.forEach((itemId, index) => {
      const query = availabilityQueries[index]
      if (!query) return
      map.set(itemId, {
        rows: (query.data ?? []) as ItemInventoryRow[],
        isLoading: query.isLoading,
        isError: query.isError,
      })
    })
    return map
  }, [availabilityItemIds, availabilityQueries])

  const availabilityError = availabilityQueries.some((query) => query.isError)

  const atpQuery = useQuery({
    queryKey: ['atp', workOrder.outputItemId],
    queryFn: () => getAtp({ itemId: workOrder.outputItemId }),
    enabled: Boolean(workOrder.outputItemId),
    staleTime: 30_000,
  })
  const atpRows: AtpResult[] = (atpQuery.data?.data ?? []) as AtpResult[]
  const atpByLocation = useMemo(() => {
    const map = new Map<string, AtpResult[]>()
    atpRows.forEach((row) => {
      const list = map.get(row.locationId) ?? []
      list.push(row)
      map.set(row.locationId, list)
    })
    return map
  }, [atpRows])
  const availableLocationIds = useMemo(() => {
    if (!isDisassembly) return new Set<string>()
    const set = new Set<string>()
    atpRows.forEach((row) => {
      if (row.availableToPromise > 0 && row.uom === baseOutputUom) {
        set.add(row.locationId)
      }
    })
    return set
  }, [atpRows, baseOutputUom, isDisassembly])

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locationsQuery.data],
  )
  const locationLabelById = useMemo(() => {
    const map = new Map<string, string>()
    locationOptions.forEach((loc) => map.set(loc.value, loc.label))
    return map
  }, [locationOptions])
  const filteredLocationOptions = useMemo(() => {
    if (!isDisassembly) return locationOptions
    return locationOptions.filter((loc) => availableLocationIds.has(loc.value))
  }, [availableLocationIds, isDisassembly, locationOptions])

  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
  const effectiveDefaultFrom = defaultFromLocationId || baseConsumeLocationId
  const normalizedDefaultFrom = validLocationIds.has(effectiveDefaultFrom) ? effectiveDefaultFrom : ''
  const usingItemConsumeDefault =
    !workOrder.defaultConsumeLocationId &&
    !localDefaults.consumeLocationId &&
    outputItem?.defaultLocationId &&
    normalizedDefaultFrom === outputItem.defaultLocationId

  useEffect(() => {
    setLines((prev) =>
      prev.map((line) => ({
        ...line,
        fromLocationId: line.fromLocationId || effectiveDefaultFrom,
        uom: line.uom || baseOutputUom,
      })),
    )
  }, [effectiveDefaultFrom, baseOutputUom])

  useEffect(() => {
    if (!itemsQuery.data?.data?.length) return
    setLines((prev) => {
      let changed = false
      const next = prev.map((line) => {
        if (!line.componentItemId) return line
        const component = itemsLookup.get(line.componentItemId)
        const componentLocation = component?.defaultLocationId
        if (!componentLocation) return line
        if (!line.fromLocationId || line.fromLocationId === normalizedDefaultFrom) {
          if (line.fromLocationId !== componentLocation) {
            changed = true
            return { ...line, fromLocationId: componentLocation }
          }
        }
        return line
      })
      return changed ? next : prev
    })
  }, [itemsQuery.data, itemsLookup, normalizedDefaultFrom])

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      {
        componentItemId: isDisassembly ? workOrder.outputItemId : '',
        fromLocationId: normalizedDefaultFrom,
        uom: baseOutputUom,
        quantityIssued: '',
      },
    ])

  const onComponentChange = (index: number, nextValue: string) => {
    const selected = itemsLookup.get(nextValue)
    const suggestedUom = selected?.defaultUom || baseOutputUom
    setLines((prev) =>
      prev.map((line, i) =>
        i === index
          ? {
              ...line,
              componentItemId: nextValue,
              uom: line.uom || suggestedUom,
            }
          : line,
      ),
    )
  }

  const updateLine = (index: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const onSelectDefaultFromLocation = (locId: string) => {
    setDefaultFromLocationId(locId)
    setWorkOrderDefaults(workOrder.id, { consumeLocationId: locId })
    defaultsMutation.mutate(locId)
    setLines((prev) =>
      prev.map((line) => ({ ...line, fromLocationId: line.fromLocationId || locId })),
    )
  }

  const availableForLine = (line: Line) => {
    if (!line.componentItemId || !line.fromLocationId || !line.uom) return null
    if (isDisassembly && line.componentItemId === workOrder.outputItemId) {
      const candidates = atpByLocation.get(line.fromLocationId) ?? []
      const match = candidates.find((row) => row.uom === line.uom)
      return match?.availableToPromise ?? 0
    }
    const availability = availabilityByItem.get(line.componentItemId)
    if (!availability || availability.isLoading || availability.isError) return null
    const match = availability.rows.find(
      (row) => row.locationId === line.fromLocationId && row.uom === line.uom,
    )
    return match?.onHand ?? 0
  }

  const validate = (): string | null => {
    if (lines.length === 0) return 'Add at least one line.'
    for (const line of lines) {
      if (!line.componentItemId || !line.fromLocationId || !line.uom || line.quantityIssued === '') {
        return 'All line fields are required.'
      }
      if (isDisassembly && line.componentItemId !== workOrder.outputItemId) {
        return 'Disassembly issues must consume the selected item to disassemble.'
      }
      if (!validLocationIds.has(line.fromLocationId)) return 'Select a valid consume location.'
      if (Number(line.quantityIssued) <= 0) return 'Quantities must be greater than zero.'
      const availableQty = availableForLine(line)
      if (availableQty !== null && Number(line.quantityIssued) > availableQty) {
        return 'Quantity exceeds available inventory at the selected location.'
      }
    }
    return null
  }

  const totalIssued = useMemo(
    () =>
      lines.reduce((sum, line) => sum + (Number(line.quantityIssued) || 0), 0),
    [lines],
  )

  const onSubmitDraft = () => {
    const validation = validate()
    if (validation) {
      setWarning(validation)
      return
    }
    setWarning(null)
    issueMutation.mutate({
      occurredAt: new Date(occurredAt).toISOString(),
      notes: notes || undefined,
      lines: lines.map((line, idx) => ({
        lineNumber: idx + 1,
        componentItemId: line.componentItemId,
        fromLocationId: line.fromLocationId,
        uom: line.uom,
        quantityIssued: Number(line.quantityIssued),
        reasonCode: line.reasonCode || undefined,
        notes: line.notes,
      })),
    })
  }

  const onConfirmPost = () => {
    if (!createdIssue) return
    postMutation.mutate({ issueId: createdIssue.id })
  }

  const isPosted = createdIssue?.status === 'posted'

  return (
    <Card
      title={isDisassembly ? 'Consume parent item' : 'Use materials'}
      description={
        isDisassembly
          ? 'Consume the item being disassembled. Save a draft, then post to move inventory.'
          : 'Save a draft, then post to create the inventory movement.'
      }
    >
      {issueMutation.isPending && <LoadingSpinner label="Creating issue..." />}
      {postMutation.isPending && <LoadingSpinner label="Posting issue..." />}
      {warning && <Alert variant="warning" title="Fix validation" message={warning} />}
      {issueMutation.isError && (
        <Alert
          variant="error"
          title="Create failed"
          message={issueMutation.error.message}
        />
      )}
      {postMutation.isError && (
        <Alert variant="error" title="Post failed" message={postMutation.error.message} />
      )}
      {defaultsMutation.isError && (
        <Alert
          variant="error"
          title="Default consume location not updated"
          message={(defaultsMutation.error as ApiError)?.message ?? 'Failed to update default consume location.'}
        />
      )}
      {availabilityError && (
        <Alert
          variant="warning"
          title="Availability unavailable"
          message="Check item inventory snapshots before issuing to avoid stalled work."
        />
      )}
      {createdIssue && (
        <Alert
          variant={isPosted ? 'success' : 'info'}
          title={isPosted ? 'Issue posted' : 'Issue draft created'}
          message={isPosted ? 'Inventory consumption recorded.' : 'Draft saved and ready to post.'}
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

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Lines</div>
          <div className="flex gap-2">
            {!isDisassembly && (
              <Button variant="secondary" size="sm" onClick={() => requirementsMutation.mutate()}>
                {requirementsMutation.isPending ? 'Loading…' : 'Load from BOM'}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={addLine}>
              Add line
            </Button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default consume location</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={normalizedDefaultFrom}
              onChange={(e) => onSelectDefaultFromLocation(e.target.value)}
              disabled={locationsQuery.isLoading || (isDisassembly && filteredLocationOptions.length === 0)}
            >
              <option value="">Select location</option>
              {(isDisassembly ? filteredLocationOptions : locationOptions).map((loc) => (
                <option key={loc.value} value={loc.value}>
                  {loc.label}
                </option>
              ))}
            </select>
            {usingItemConsumeDefault && (
              <p className="text-xs text-slate-500">Auto from item default location</p>
            )}
            {isDisassembly && filteredLocationOptions.length === 0 && (
              <p className="text-xs text-amber-700">No available inventory to consume.</p>
            )}
          </label>
        </div>
        {lines.map((line, idx) => {
          const hasLineError =
            !line.componentItemId ||
            !line.fromLocationId ||
            !line.uom ||
            line.quantityIssued === '' ||
            (line.quantityIssued !== '' && Number(line.quantityIssued) <= 0)
          return (
          <div
            key={idx}
            className={`grid gap-3 rounded-lg border p-3 ${
              hasLineError ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
            } ${isDisassembly ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}
          >
            <div>
              <Combobox
                label={isDisassembly ? 'Input item' : 'Component item'}
                value={line.componentItemId}
                options={itemOptions}
                loading={itemsQuery.isLoading}
                onQueryChange={setItemSearch}
                placeholder="Search items (SKU/name)"
                onChange={(nextValue) => onComponentChange(idx, nextValue)}
              />
            </div>
            <div>
              <Combobox
                label="From location"
                value={line.fromLocationId}
                options={
                  isDisassembly && line.componentItemId === workOrder.outputItemId
                    ? filteredLocationOptions
                    : locationOptions
                }
                loading={locationsQuery.isLoading}
                onQueryChange={setLocationSearch}
                placeholder="Search locations (code/name)"
                onChange={(nextValue) => updateLine(idx, { fromLocationId: nextValue })}
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
                value={line.quantityIssued}
                disabled={
                  (() => {
                    const availableQty = availableForLine(line)
                    return availableQty !== null && availableQty <= 0
                  })()
                }
                onChange={(e) =>
                  updateLine(idx, {
                    quantityIssued: e.target.value === '' ? '' : Number(e.target.value),
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
                  placeholder="breakage, rework"
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
                {line.componentItemId && line.fromLocationId && line.uom && (
                  <div className="text-xs text-slate-500">
                    {(() => {
                      const availableQty = availableForLine(line)
                      if (availableQty === null) return 'Available: —'
                      const qty = Number(line.quantityIssued)
                      const hasQty = line.quantityIssued !== '' && Number.isFinite(qty)
                      const after = hasQty ? availableQty - qty : null
                      return (
                        <span className={after !== null && after < 0 ? 'text-red-600' : undefined}>
                          Available: {formatNumber(availableQty)} {line.uom}
                          {after !== null ? ` · After issue: ${formatNumber(after)} ${line.uom}` : ''}
                        </span>
                      )
                    })()}
                  </div>
                )}
                {line.componentItemId &&
                  line.fromLocationId &&
                  line.uom &&
                  (() => {
                    const availableQty = availableForLine(line)
                    if (availableQty !== null && availableQty <= 0) {
                      return (
                        <div className="text-xs text-amber-700">
                          No available inventory at this location.
                        </div>
                      )
                    }
                    return null
                  })()}
              </label>
              {lines.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => removeLine(idx)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        )})}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          Total to issue:{' '}
          <span className={totalIssued > 0 ? 'font-semibold text-red-600' : 'font-semibold text-slate-700'}>
            {totalIssued > 0 ? `-${formatNumber(totalIssued)}` : formatNumber(0)}
          </span>{' '}
          {lines[0]?.uom || ''}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onSubmitDraft} disabled={issueMutation.isPending}>
            Save draft
          </Button>
          <Button
            size="sm"
            onClick={() => setShowPostConfirm(true)}
            disabled={!createdIssue || isPosted || postMutation.isPending}
          >
            Post issue (affects inventory)
          </Button>
        </div>
      </div>

      <PostConfirmModal
        isOpen={showPostConfirm}
        onCancel={() => setShowPostConfirm(false)}
        onConfirm={onConfirmPost}
        title="Post Issue?"
        body="Posting creates an inventory movement and cannot be edited. Drafts do not affect inventory until posted."
        preview={
          <div className="space-y-1 text-sm text-slate-800">
            {createdIssue?.lines.map((line) => (
              <div key={line.id} className="flex justify-between">
                <span>
                  {itemOptions.find((item) => item.value === line.componentItemId)?.label || 'Item'} @{' '}
                  {locationLabelById.get(line.fromLocationId) || 'Location'}
                </span>
                <span className="text-red-600">
                  -{formatNumber(line.quantityIssued)} {line.uom}
                </span>
              </div>
            ))}
          </div>
        }
      />

      {isPosted && createdIssue?.inventoryMovementId && (
        <div className="mt-4">
          <LotAllocationsCard
            movementId={createdIssue.inventoryMovementId}
            title="Assign lots for this issue movement"
          />
        </div>
      )}
    </Card>
  )
}
