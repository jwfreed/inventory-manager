import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
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
} from '../../../api/endpoints/workOrders'
import { listItems } from '../../../api/endpoints/items'
import { listLocations } from '../../../api/endpoints/locations'
import type { ApiError, WorkOrderIssue, WorkOrder } from '../../../api/types'
import type { Item, Location } from '../../../api/types'
import { PostConfirmModal } from './PostConfirmModal'
import { formatNumber } from '../../../lib/formatters'
import { LotAllocationsCard } from './LotAllocationsCard'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'

type Line = {
  componentItemId: string
  fromLocationId: string
  uom: string
  quantityIssued: number | ''
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  onRefetch: () => void
}

export function IssueDraftForm({ workOrder, onRefetch }: Props) {
  const localDefaults = getWorkOrderDefaults(workOrder.id)
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [defaultFromLocationId, setDefaultFromLocationId] = useState<string>(
    workOrder.defaultConsumeLocationId ?? localDefaults.consumeLocationId ?? '',
  )
  const [lines, setLines] = useState<Line[]>([
    { componentItemId: '', fromLocationId: defaultFromLocationId, uom: workOrder.outputUom, quantityIssued: '' },
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
      void onRefetch()
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
        .map((line) => ({
          componentItemId: line.componentItemId,
          fromLocationId: defaultFromLocationId,
          uom: line.uom,
          quantityIssued: line.quantityRequired,
        }))
      setLines(nextLines.length > 0 ? nextLines : [{ componentItemId: '', fromLocationId: defaultFromLocationId, uom: workOrder.outputUom, quantityIssued: '' }])
      setWarning(null)
    },
    onError: (err: ApiError | unknown) => {
      const message = (err as ApiError)?.message ?? 'Failed to load requirements.'
      setWarning(message)
    },
  })

  const itemsQuery = useQuery<{ data: Item[] }, ApiError>({
    queryKey: ['items', 'wo-issue', itemSearch],
    queryFn: () => listItems({ limit: 200, search: itemSearch || undefined }),
    staleTime: 60_000,
    retry: 1,
  })

  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'wo-issue', locationSearch],
    queryFn: () => listLocations({ limit: 200, search: locationSearch || undefined, active: true }),
    staleTime: 60_000,
    retry: 1,
  })

  const itemOptions = useMemo(
    () =>
      (itemsQuery.data?.data ?? []).map((item) => ({
        value: item.id,
        label: `${item.sku} — ${item.name}`,
        keywords: `${item.sku} ${item.name}`,
      })),
    [itemsQuery.data],
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

  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
  const normalizedDefaultFrom = validLocationIds.has(defaultFromLocationId) ? defaultFromLocationId : ''

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      { componentItemId: '', fromLocationId: normalizedDefaultFrom, uom: workOrder.outputUom, quantityIssued: '' },
    ])

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

  const validate = (): string | null => {
    if (lines.length === 0) return 'Add at least one line.'
    for (const line of lines) {
      if (!line.componentItemId || !line.fromLocationId || !line.uom || line.quantityIssued === '') {
        return 'All line fields are required.'
      }
      if (!validLocationIds.has(line.fromLocationId)) return 'Select a valid consume location.'
      if (Number(line.quantityIssued) <= 0) return 'Quantities must be greater than zero.'
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
    <Card title="Create material issue" description="Draft first, then post to create inventory movement.">
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
      {createdIssue && (
        <Alert
          variant={isPosted ? 'success' : 'info'}
          title={isPosted ? 'Issue posted' : 'Issue draft created'}
          message={`Issue ID: ${createdIssue.id}`}
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
            <Button variant="secondary" size="sm" onClick={() => requirementsMutation.mutate()}>
              {requirementsMutation.isPending ? 'Loading…' : 'Load from BOM'}
            </Button>
            <Button variant="secondary" size="sm" onClick={addLine}>
              Add line
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
            <span className="text-xs uppercase tracking-wide text-slate-500">Location search</span>
            <Input
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
              placeholder="Search locations (code/name)"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default consume location</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={normalizedDefaultFrom}
              onChange={(e) => onSelectDefaultFromLocation(e.target.value)}
              disabled={locationsQuery.isLoading}
            >
              <option value="">Select location</option>
              {locationOptions.map((loc) => (
                <option key={loc.value} value={loc.value}>
                  {loc.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {lines.map((line, idx) => (
          <div
            key={idx}
            className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5"
          >
            <div>
              <SearchableSelect
                label="Component item"
                value={line.componentItemId}
                options={itemOptions}
                disabled={itemsQuery.isLoading}
                onChange={(nextValue) => updateLine(idx, { componentItemId: nextValue })}
              />
            </div>
            <div>
              <SearchableSelect
                label="From location"
                value={line.fromLocationId}
                options={locationOptions}
                disabled={locationsQuery.isLoading}
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
                onChange={(e) =>
                  updateLine(idx, {
                    quantityIssued: e.target.value === '' ? '' : Number(e.target.value),
                  })
                }
              />
            </label>
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
            Total to issue:{' '}
            <span className="font-semibold text-red-600">-{formatNumber(totalIssued)}</span>{' '}
            {lines[0]?.uom || ''}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onSubmitDraft} disabled={issueMutation.isPending}>
              Save issue draft
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPostConfirm(true)}
              disabled={!createdIssue || isPosted || postMutation.isPending}
            >
              Post issue to inventory
            </Button>
          </div>
        </div>

      <PostConfirmModal
        isOpen={showPostConfirm}
        onCancel={() => setShowPostConfirm(false)}
        onConfirm={onConfirmPost}
        title="Post Issue?"
        body="This will create exactly 1 inventory movement (type: issue) with negative deltas for the lines below. Drafts do not affect inventory until posted."
        preview={
          <div className="space-y-1 text-sm text-slate-800">
            {createdIssue?.lines.map((line) => (
              <div key={line.id} className="flex justify-between">
                <span>
                  {line.componentItemId} @ {line.fromLocationId}
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
