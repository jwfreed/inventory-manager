import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError, Item, Location } from '@api/types'
import { Alert, Badge, Button, Card, Input, Section, Textarea } from '@shared/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useItemsList, useItem } from '@features/items/queries'
import { useLocationsList, useLocation } from '@features/locations/queries'
import {
  createInventoryAdjustment,
  postInventoryAdjustment,
  type AdjustmentPayload,
} from '../api/adjustments'
import { useInventoryAdjustment } from '../queries'
import { AdjustmentLinesEditor } from '../components/AdjustmentLinesEditor'
import { adjustmentReasonOptions, type AdjustmentLineDraft } from '../types'
import { buildTotalsByUom, makeLineKey, toDateTimeLocal, toIsoFromDateTimeLocal } from '../utils'
import { formatNumber } from '@shared/formatters'

type LineError = {
  itemId?: string
  locationId?: string
  uom?: string
  quantityDelta?: string
}

const defaultLine = (opts?: { itemId?: string | null; locationId?: string | null }) => ({
  key: makeLineKey(),
  itemId: opts?.itemId ?? '',
  locationId: opts?.locationId ?? '',
  uom: '',
  quantityDelta: '',
  notes: '',
})

function formatApiError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (apiErr?.details && typeof apiErr.details === 'object') {
    const fieldErrors = (apiErr.details as { error?: { fieldErrors?: Record<string, string[]> } })
      .error?.fieldErrors
    if (fieldErrors) {
      return Object.entries(fieldErrors)
        .flatMap(([field, messages]) => (messages ?? []).map((message) => `${field}: ${message}`))
        .join(' ')
    }
  }
  if (apiErr?.message) return apiErr.message
  return fallback
}

export default function AdjustmentNewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const itemIdFromQuery = searchParams.get('itemId') ?? ''
  const locationIdFromQuery = searchParams.get('locationId') ?? ''
  const fromAdjustmentId = searchParams.get('fromAdjustmentId') ?? ''
  const lineIdsParam = searchParams.get('lineIds') ?? ''
  const lineIds = lineIdsParam ? lineIdsParam.split(',') : []

  const [lockItemId, setLockItemId] = useState<string | null>(itemIdFromQuery || null)
  const [lockLocationId, setLockLocationId] = useState<string | null>(locationIdFromQuery || null)
  const [occurredAt, setOccurredAt] = useState(() => toDateTimeLocal(new Date().toISOString()))
  const [reasonCode, setReasonCode] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<AdjustmentLineDraft[]>(() => [
    defaultLine({ itemId: itemIdFromQuery, locationId: locationIdFromQuery }),
  ])
  const [showErrors, setShowErrors] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitMessage, setSubmitMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [prefillApplied, setPrefillApplied] = useState(false)

  const itemsQuery = useItemsList({ active: true, limit: 200 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })
  const itemDetailQuery = useItem(itemIdFromQuery || undefined, { enabled: Boolean(itemIdFromQuery) })
  const locationDetailQuery = useLocation(locationIdFromQuery || undefined, {
    enabled: Boolean(locationIdFromQuery),
  })
  const fromAdjustmentQuery = useInventoryAdjustment(fromAdjustmentId || undefined, {
    enabled: Boolean(fromAdjustmentId),
  })

  const items = useMemo<Item[]>(() => {
    const list = itemsQuery.data?.data ?? []
    if (!itemDetailQuery.data) return list
    if (list.some((item) => item.id === itemDetailQuery.data?.id)) return list
    return [itemDetailQuery.data, ...list]
  }, [itemsQuery.data, itemDetailQuery.data])

  const locations = useMemo<Location[]>(() => {
    const list = locationsQuery.data?.data ?? []
    if (!locationDetailQuery.data) return list
    if (list.some((loc) => loc.id === locationDetailQuery.data?.id)) return list
    return [locationDetailQuery.data, ...list]
  }, [locationsQuery.data, locationDetailQuery.data])

  const itemOptions = useMemo(
    () =>
      items.map((item) => ({
        value: item.id,
        label: `${item.sku} — ${item.name}`,
        keywords: `${item.sku} ${item.name}`,
      })),
    [items],
  )

  const locationOptions = useMemo(
    () =>
      locations.map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
        keywords: `${loc.code} ${loc.name} ${loc.type}`,
      })),
    [locations],
  )

  const itemMap = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const locationMap = useMemo(
    () => new Map(locations.map((loc) => [loc.id, loc])),
    [locations],
  )

  useEffect(() => {
    if (!fromAdjustmentQuery.data || prefillApplied) return
    const sourceLines = fromAdjustmentQuery.data.lines ?? []
    const filtered = lineIds.length
      ? sourceLines.filter((line) => lineIds.includes(line.id))
      : sourceLines
    if (filtered.length === 0) return
    setLines(
      filtered.map((line) => ({
        key: makeLineKey(),
        itemId: line.itemId,
        locationId: line.locationId,
        uom: line.uom,
        quantityDelta: line.quantityDelta,
        notes: line.notes ?? '',
      })),
    )
    setPrefillApplied(true)
  }, [fromAdjustmentQuery.data, lineIds, prefillApplied])

  const updateLine = (index: number, patch: Partial<AdjustmentLineDraft>) => {
    setLines((prev) =>
      prev.map((line, idx) => {
        if (idx !== index) return line
        const updated = { ...line, ...patch }
        if (patch.itemId && !line.uom) {
          const item = itemMap.get(patch.itemId)
          if (item?.defaultUom) updated.uom = item.defaultUom
        }
        if (lockItemId) updated.itemId = lockItemId
        if (lockLocationId) updated.locationId = lockLocationId
        return updated
      }),
    )
  }

  const addLine = () => {
    setLines((prev) => [...prev, defaultLine({ itemId: lockItemId, locationId: lockLocationId })])
  }

  const duplicateLine = (index: number) => {
    setLines((prev) => {
      const target = prev[index]
      if (!target) return prev
      const clone = { ...target, key: makeLineKey() }
      return [...prev.slice(0, index + 1), clone, ...prev.slice(index + 1)]
    })
  }

  const removeLine = (index: number) => {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== index)))
  }

  const lineErrors = useMemo<Record<string, LineError>>(() => {
    const errors: Record<string, LineError> = {}
    lines.forEach((line) => {
      const entry: LineError = {}
      if (!line.itemId) entry.itemId = 'Select an item.'
      if (!line.locationId) entry.locationId = 'Select a location.'
      if (!line.uom) entry.uom = 'UOM is required.'
      const qty = Number(line.quantityDelta)
      if (!Number.isFinite(qty) || qty === 0) entry.quantityDelta = 'Enter a non-zero delta.'
      if (Object.keys(entry).length > 0) errors[line.key] = entry
    })
    return errors
  }, [lines])

  const headerErrors = useMemo(() => {
    const errs: string[] = []
    if (!reasonCode.trim()) errs.push('Reason code is required.')
    if (!occurredAt) errs.push('Occurred at is required.')
    if (lines.length === 0) errs.push('Add at least one line.')
    return errs
  }, [reasonCode, occurredAt, lines.length])

  const totals = useMemo(() => buildTotalsByUom(lines), [lines])
  const totalLines = lines.length
  const hasErrors = headerErrors.length > 0 || Object.keys(lineErrors).length > 0

  const handleSubmit = async (postAfter: boolean) => {
    if (hasErrors) {
      setShowErrors(true)
      setSubmitError('Fix validation issues before saving.')
      return
    }

    const occurredAtIso = toIsoFromDateTimeLocal(occurredAt)
    if (!occurredAtIso) {
      setShowErrors(true)
      setSubmitError('Invalid occurred at value.')
      return
    }

    const payload: AdjustmentPayload = {
      occurredAt: occurredAtIso,
      notes: notes.trim() || undefined,
      lines: lines.map((line, idx) => ({
        lineNumber: idx + 1,
        itemId: line.itemId,
        locationId: line.locationId,
        uom: line.uom,
        quantityDelta: Number(line.quantityDelta),
        reasonCode: reasonCode.trim(),
        notes: line.notes.trim() || undefined,
      })),
    }

    setIsSubmitting(true)
    setSubmitError(null)
    setSubmitMessage(null)
    try {
      const adjustment = await createInventoryAdjustment(payload)
      if (postAfter) {
        const posted = await postInventoryAdjustment(adjustment.id)
        await queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
        navigate(`/inventory-adjustments/${posted.id}`)
        return
      }
      await queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
      setSubmitMessage('Draft saved. You can continue editing from the detail page.')
      navigate(`/inventory-adjustments/${adjustment.id}`)
    } catch (err) {
      setSubmitError(formatApiError(err, 'Failed to save adjustment.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const lockedItem = lockItemId ? itemMap.get(lockItemId) : null
  const lockedLocation = lockLocationId ? locationMap.get(lockLocationId) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Inventory control</p>
          <h2 className="text-2xl font-semibold text-slate-900">New inventory adjustment</h2>
          <p className="text-sm text-slate-600">Create a draft and post when ready.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/inventory-adjustments')}>
          Back to list
        </Button>
      </div>

      {submitMessage && (
        <Alert variant="success" title="Saved" message={submitMessage} />
      )}
      {submitError && <Alert variant="error" title="Adjustment error" message={submitError} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Section title="Header">
            <Card>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Reason code</span>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={reasonCode}
                    onChange={(e) => setReasonCode(e.target.value)}
                  >
                    <option value="">Select reason</option>
                    {adjustmentReasonOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {showErrors && !reasonCode.trim() && (
                    <div className="text-xs text-red-600">Reason code is required.</div>
                  )}
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Occurred at</span>
                  <Input
                    type="datetime-local"
                    value={occurredAt}
                    onChange={(e) => setOccurredAt(e.target.value)}
                  />
                  {showErrors && !occurredAt && (
                    <div className="text-xs text-red-600">Occurred at is required.</div>
                  )}
                </label>
              </div>
              <label className="mt-4 block space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional narrative (why this adjustment is needed)"
                />
              </label>
              {(lockItemId || lockLocationId) && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                  {lockItemId && (
                    <Badge variant="info">
                      Item locked: {lockedItem?.sku ?? lockItemId}
                    </Badge>
                  )}
                  {lockLocationId && (
                    <Badge variant="info">
                      Location locked: {lockedLocation?.code ?? lockLocationId}
                    </Badge>
                  )}
                  {lockItemId && (
                    <Button variant="secondary" size="sm" onClick={() => setLockItemId(null)}>
                      Change item
                    </Button>
                  )}
                  {lockLocationId && (
                    <Button variant="secondary" size="sm" onClick={() => setLockLocationId(null)}>
                      Change location
                    </Button>
                  )}
                </div>
              )}
            </Card>
          </Section>

          <Section title="Lines" description="Each line is a signed delta at a specific item and location.">
            <AdjustmentLinesEditor
              lines={lines}
              itemOptions={itemOptions}
              locationOptions={locationOptions}
              lockItemId={lockItemId}
              lockLocationId={lockLocationId}
              lineErrors={lineErrors}
              showErrors={showErrors}
              onLineChange={updateLine}
              onAddLine={addLine}
              onDuplicateLine={duplicateLine}
              onRemoveLine={removeLine}
            />
          </Section>
        </div>

        <div className="space-y-4 lg:sticky lg:top-6">
          <Card>
            <div className="space-y-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Summary</div>
                <div className="mt-1 text-sm text-slate-700">
                  {totalLines} line{totalLines === 1 ? '' : 's'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Net delta</div>
                {totals.length === 0 ? (
                  <div className="text-sm text-slate-600">—</div>
                ) : (
                  <div className="mt-1 space-y-1 text-sm text-slate-700">
                    {totals.map((total) => {
                      const sign = total.quantityDelta > 0 ? '+' : total.quantityDelta < 0 ? '−' : ''
                      return (
                        <div key={total.uom}>
                          {sign}
                          {formatNumber(Math.abs(total.quantityDelta))} {total.uom}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              {showErrors && headerErrors.length > 0 && (
                <Alert
                  variant="error"
                  title="Missing required fields"
                  message={headerErrors.join(' ')}
                />
              )}
              <div className="flex flex-col gap-2 pt-2">
                <Button onClick={() => handleSubmit(true)} disabled={isSubmitting}>
                  Post adjustment
                </Button>
                <Button variant="secondary" onClick={() => handleSubmit(false)} disabled={isSubmitting}>
                  Save draft
                </Button>
                <Button variant="secondary" onClick={() => navigate('/inventory-adjustments')} disabled={isSubmitting}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
