import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
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
} from '../../../api/endpoints/workOrders'
import type { ApiError, WorkOrder, WorkOrderCompletion } from '../../../api/types'
import type { Location } from '../../../api/types'
import { PostConfirmModal } from './PostConfirmModal'
import { formatNumber } from '../../../lib/formatters'
import { LotAllocationsCard } from './LotAllocationsCard'
import { listLocations } from '../../../api/endpoints/locations'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { getWorkOrderDefaults, setWorkOrderDefaults } from '../hooks/useWorkOrderDefaults'

type Line = {
  outputItemId: string
  toLocationId: string
  uom: string
  quantityCompleted: number | ''
  notes?: string
}

type Props = {
  workOrder: WorkOrder
  onRefetch: () => void
}

export function CompletionDraftForm({ workOrder, onRefetch }: Props) {
  const defaults = getWorkOrderDefaults(workOrder.id)
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [notes, setNotes] = useState('')
  const [locationSearch, setLocationSearch] = useState('')
  const [defaultToLocationId, setDefaultToLocationId] = useState<string>(
    workOrder.defaultProduceLocationId ?? defaults.produceLocationId ?? '',
  )
  const [lines, setLines] = useState<Line[]>([
    {
      outputItemId: workOrder.outputItemId,
      toLocationId: defaultToLocationId,
      uom: workOrder.outputUom,
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
      void onRefetch()
    },
  })

  const locationsQuery = useQuery<{ data: Location[] }, ApiError>({
    queryKey: ['locations', 'wo-completion', locationSearch],
    queryFn: () => listLocations({ limit: 200, search: locationSearch || undefined, active: true }),
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
  const validLocationIds = useMemo(() => new Set(locationOptions.map((o) => o.value)), [locationOptions])
  const normalizedDefaultTo = validLocationIds.has(defaultToLocationId) ? defaultToLocationId : ''

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      {
        outputItemId: workOrder.outputItemId,
        toLocationId: normalizedDefaultTo,
        uom: workOrder.outputUom,
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

  const validate = (): string | null => {
    if (lines.length === 0) return 'Add at least one line.'
    for (const line of lines) {
      if (!line.toLocationId || !line.uom || line.quantityCompleted === '') {
        return 'All line fields are required.'
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
        outputItemId: workOrder.outputItemId,
        toLocationId: line.toLocationId,
        uom: line.uom,
        quantityCompleted: Number(line.quantityCompleted),
        packSize: line.packSize ? Number(line.packSize) : undefined,
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
    <Card title="Create completion" description="Draft first, then post to create production movement.">
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
          message={`Completion ID: ${createdCompletion.id}`}
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
          <Button variant="secondary" size="sm" onClick={addLine}>
            Add line
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
          </label>
        </div>
        {lines.map((line, idx) => (
          <div
            key={idx}
            className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5"
          >
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
            <span className="font-semibold text-green-700">+{formatNumber(totalCompleted)}</span>{' '}
            {lines[0]?.uom || ''}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onSubmitDraft}
              disabled={completionMutation.isPending}
            >
              Save completion draft
            </Button>
            <Button
              size="sm"
              onClick={() => setShowPostConfirm(true)}
              disabled={!createdCompletion || isPosted || postMutation.isPending}
            >
              Post completion to inventory
            </Button>
          </div>
        </div>

      <PostConfirmModal
        isOpen={showPostConfirm}
        onCancel={() => setShowPostConfirm(false)}
        onConfirm={onConfirmPost}
        title="Post Completion?"
        body="This will create exactly 1 inventory movement (type: receive) with positive deltas and update this work order’s quantity completed."
        preview={
          <div className="space-y-1 text-sm text-slate-800">
            {createdCompletion?.lines.map((line) => (
              <div key={line.id} className="flex justify-between">
                <span>
                  {line.itemId} → {line.toLocationId || 'n/a'}
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
