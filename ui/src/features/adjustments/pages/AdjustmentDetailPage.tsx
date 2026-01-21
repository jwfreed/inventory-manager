import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError, InventoryAdjustment, InventoryAdjustmentLine } from '@api/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Section,
  Textarea,
} from '@shared/ui'
import { formatDate, formatNumber } from '@shared/formatters'
import { useItemsList, useItem } from '@features/items/queries'
import { useLocationsList, useLocation } from '@features/locations/queries'
import { useMovement } from '@features/ledger/queries'
import { useAuditLog } from '@features/audit/queries'
import { AuditTrailTable } from '@features/audit/components/AuditTrailTable'
import {
  cancelInventoryAdjustment,
  createInventoryAdjustment,
  postInventoryAdjustment,
  updateInventoryAdjustment,
  type AdjustmentPayload,
} from '../api/adjustments'
import { useInventoryAdjustment } from '../queries'
import { AdjustmentLinesEditor } from '../components/AdjustmentLinesEditor'
import { AdjustmentLinesTable } from '../components/AdjustmentLinesTable'
import { adjustmentReasonOptions, type AdjustmentLineDraft } from '../types'
import { buildTotalsByUom, makeLineKey, toDateTimeLocal, toIsoFromDateTimeLocal } from '../utils'

type LineError = {
  itemId?: string
  locationId?: string
  uom?: string
  quantityDelta?: string
}

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

function deriveReasonCode(lines: InventoryAdjustmentLine[]) {
  const reasons = new Set(lines.map((line) => line.reasonCode).filter(Boolean))
  if (reasons.size === 1) return Array.from(reasons)[0]
  return ''
}

type StockShortageDetail = {
  itemId: string
  locationId: string
  uom: string
  requested: number
  available: number
  shortage: number
}

export default function AdjustmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [initialized, setInitialized] = useState(false)
  const [occurredAt, setOccurredAt] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<AdjustmentLineDraft[]>([])
  const [showErrors, setShowErrors] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [postError, setPostError] = useState<string | null>(null)
  const [shortageDetails, setShortageDetails] = useState<StockShortageDetail[] | null>(null)
  const [overrideAllowed, setOverrideAllowed] = useState(false)
  const [overrideRequiresReason, setOverrideRequiresReason] = useState(false)
  const [overrideNegative, setOverrideNegative] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [showCorrectionModal, setShowCorrectionModal] = useState(false)
  const [correctionReason, setCorrectionReason] = useState('correction')
  const [correctionNotes, setCorrectionNotes] = useState('')
  const [correctionOccurredAt, setCorrectionOccurredAt] = useState(
    toDateTimeLocal(new Date().toISOString()),
  )
  const [correctionLineIds, setCorrectionLineIds] = useState<Set<string>>(new Set())
  const [createReplacement, setCreateReplacement] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const adjustmentQuery = useInventoryAdjustment(id, {
    retry: (failureCount, error: ApiError) => error?.status !== 404 && failureCount < 1,
  })

  const movementQuery = useMovement(adjustmentQuery.data?.inventoryMovementId ?? undefined, {
    enabled: Boolean(adjustmentQuery.data?.inventoryMovementId),
  })

  const auditQuery = useAuditLog(
    { entityType: 'inventory_adjustment', entityId: id ?? '', limit: 50, offset: 0 },
    { enabled: Boolean(id) },
  )

  const itemsQuery = useItemsList({ lifecycleStatus: 'Active', limit: 200 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })
  const itemDetailQuery = useItem(adjustmentQuery.data?.lines?.[0]?.itemId, {
    enabled: Boolean(adjustmentQuery.data?.lines?.[0]?.itemId),
  })
  const locationDetailQuery = useLocation(adjustmentQuery.data?.lines?.[0]?.locationId, {
    enabled: Boolean(adjustmentQuery.data?.lines?.[0]?.locationId),
  })

  useEffect(() => {
    if (adjustmentQuery.isError && adjustmentQuery.error?.status === 404) {
      navigate('/not-found', { replace: true })
    }
  }, [adjustmentQuery.isError, adjustmentQuery.error, navigate])

  useEffect(() => {
    if (!adjustmentQuery.data || initialized) return
    const adjustment = adjustmentQuery.data
    setOccurredAt(toDateTimeLocal(adjustment.occurredAt))
    setNotes(adjustment.notes ?? '')
    if (adjustment.lines && adjustment.lines.length > 0) {
      setReasonCode(deriveReasonCode(adjustment.lines))
      setLines(
        adjustment.lines.map((line) => ({
          key: makeLineKey(),
          itemId: line.itemId,
          locationId: line.locationId,
          uom: line.uom,
          quantityDelta: line.quantityDelta,
          notes: line.notes ?? '',
        })),
      )
    } else {
      setLines([
        {
          key: makeLineKey(),
          itemId: '',
          locationId: '',
          uom: '',
          quantityDelta: '',
          notes: '',
        },
      ])
    }
    setInitialized(true)
  }, [adjustmentQuery.data, initialized])

  const items = useMemo(() => {
    const list = itemsQuery.data?.data ?? []
    if (!itemDetailQuery.data) return list
    if (list.some((item) => item.id === itemDetailQuery.data?.id)) return list
    return [itemDetailQuery.data, ...list]
  }, [itemsQuery.data, itemDetailQuery.data])

  const locations = useMemo(() => {
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
  const locationMap = useMemo(() => new Map(locations.map((loc) => [loc.id, loc])), [locations])

  const updateLine = (index: number, patch: Partial<AdjustmentLineDraft>) => {
    setLines((prev) =>
      prev.map((line, idx) => {
        if (idx !== index) return line
        const updated = { ...line, ...patch }
        if (patch.itemId && !line.uom) {
          const item = itemMap.get(patch.itemId)
          if (item?.defaultUom) updated.uom = item.defaultUom
        }
        return updated
      }),
    )
  }

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { key: makeLineKey(), itemId: '', locationId: '', uom: '', quantityDelta: '', notes: '' },
    ])
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
  const hasErrors = headerErrors.length > 0 || Object.keys(lineErrors).length > 0

  const updateMutation = useMutation({
    mutationFn: async () => {
      const occurredAtIso = toIsoFromDateTimeLocal(occurredAt)
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
      return updateInventoryAdjustment(id as string, payload)
    },
    onSuccess: () => {
      setSaveError(null)
      setSaveMessage('Draft saved.')
      void adjustmentQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
    },
    onError: (err) => {
      setSaveMessage(null)
      setSaveError(formatApiError(err, 'Failed to save draft.'))
    },
  })

  const postMutation = useMutation({
    mutationFn: () =>
      postInventoryAdjustment(id as string, {
        overrideNegative: overrideNegative || undefined,
        overrideReason: overrideNegative ? overrideReason.trim() || undefined : undefined,
      }),
    onSuccess: () => {
      setPostError(null)
      setShortageDetails(null)
      setOverrideAllowed(false)
      setOverrideRequiresReason(false)
      setOverrideNegative(false)
      setOverrideReason('')
      setSaveMessage('Adjustment posted. The record is now immutable.')
      void adjustmentQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
    },
    onError: (err) => {
      const apiErr = err as ApiError
      const detailPayload = apiErr?.details as { error?: any } | undefined
      const errorBody = detailPayload?.error ?? detailPayload
      if (errorBody?.code === 'INSUFFICIENT_STOCK') {
        const details = errorBody.details ?? {}
        setShortageDetails((details.lines as StockShortageDetail[]) ?? [])
        setOverrideAllowed(Boolean(details.overrideAllowed))
        setOverrideRequiresReason(Boolean(details.overrideRequiresReason))
        setPostError(errorBody.message ?? 'Insufficient usable stock to post this adjustment.')
        return
      }
      if (errorBody?.code === 'DISCRETE_UOM_REQUIRES_INTEGER') {
        setPostError(errorBody.message ?? 'Whole units only for count items.')
        return
      }
      if (errorBody?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
        setPostError(errorBody.message ?? 'Override reason is required.')
        setOverrideAllowed(true)
        setOverrideRequiresReason(true)
        return
      }
      if (errorBody?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
        setPostError(errorBody.message ?? 'Negative inventory override is not allowed.')
        return
      }
      setPostError(formatApiError(err, 'Failed to post adjustment.'))
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () => cancelInventoryAdjustment(id as string),
    onSuccess: () => {
      setShowCancelConfirm(false)
      setSaveMessage('Draft canceled.')
      void adjustmentQuery.refetch()
      void queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
    },
    onError: (err) => {
      setSaveError(formatApiError(err, 'Failed to cancel adjustment.'))
    },
  })

  const handleSaveDraft = () => {
    if (hasErrors) {
      setShowErrors(true)
      setSaveError('Fix validation issues before saving.')
      return
    }
    updateMutation.mutate()
  }

  const handlePost = () => {
    if (hasErrors) {
      setShowErrors(true)
      setPostError('Fix validation issues before posting.')
      return
    }
    if (overrideNegative && overrideRequiresReason && !overrideReason.trim()) {
      setPostError('Override reason is required.')
      return
    }
    setShortageDetails(null)
    postMutation.mutate()
  }

  const openCorrectionModal = () => {
    if (!adjustmentQuery.data) return
    setCorrectionReason('correction')
    setCorrectionNotes(`Reversal of adjustment ${adjustmentQuery.data.id}`)
    setCorrectionOccurredAt(toDateTimeLocal(new Date().toISOString()))
    setCorrectionLineIds(new Set(adjustmentQuery.data.lines?.map((line) => line.id) ?? []))
    setCreateReplacement(false)
    setCorrectionError(null)
    setShowCorrectionModal(true)
  }

  const handleCorrectionSubmit = async () => {
    if (!adjustmentQuery.data) return
    const selectedLines =
      adjustmentQuery.data.lines?.filter((line) => correctionLineIds.has(line.id)) ?? []
    if (!selectedLines.length) {
      setCorrectionError('Select at least one line to reverse.')
      return
    }
    if (!correctionReason.trim()) {
      setCorrectionError('Correction reason is required.')
      return
    }
    const occurredAtIso = toIsoFromDateTimeLocal(correctionOccurredAt)
    if (!occurredAtIso) {
      setCorrectionError('Correction occurred at is invalid.')
      return
    }

    const payload: AdjustmentPayload = {
      occurredAt: occurredAtIso,
      correctedFromAdjustmentId: adjustmentQuery.data.id,
      notes: correctionNotes.trim() || `Reversal of adjustment ${adjustmentQuery.data.id}`,
      lines: selectedLines.map((line, idx) => ({
        lineNumber: idx + 1,
        itemId: line.itemId,
        locationId: line.locationId,
        uom: line.uom,
        quantityDelta: -line.quantityDelta,
        reasonCode: correctionReason.trim(),
        notes: line.notes ?? `Correction of adjustment ${adjustmentQuery.data.id} line ${line.lineNumber}`,
      })),
    }

    setCorrectionError(null)
    try {
      const created = await createInventoryAdjustment(payload)
      await postInventoryAdjustment(created.id)
      await queryClient.invalidateQueries({ queryKey: ['inventory-adjustments'] })
      void adjustmentQuery.refetch()
      setShowCorrectionModal(false)
      setSaveMessage('Correction posted.')
      if (createReplacement) {
        const ids = selectedLines.map((line) => line.id).join(',')
        navigate(`/inventory-adjustments/new?fromAdjustmentId=${adjustmentQuery.data.id}&lineIds=${ids}`)
      }
    } catch (err) {
      setCorrectionError(formatApiError(err, 'Failed to post correction adjustment.'))
    }
  }

  const statusBadge = (adjustment?: InventoryAdjustment) => {
    if (!adjustment) return null
    if (adjustment.status === 'posted') {
      return (
        <Badge variant={adjustment.isCorrected ? 'info' : 'success'}>
          {adjustment.isCorrected ? 'Corrected' : 'Posted'}
        </Badge>
      )
    }
    if (adjustment.status === 'draft') return <Badge variant="neutral">Draft</Badge>
    if (adjustment.status === 'canceled') return <Badge variant="danger">Canceled</Badge>
    return <Badge variant="neutral">{adjustment.status}</Badge>
  }

  if (adjustmentQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Section title="Inventory adjustment">
          <Card>
            <div className="text-sm text-slate-600">Loading adjustment...</div>
          </Card>
        </Section>
      </div>
    )
  }

  const adjustment = adjustmentQuery.data
  if (!adjustment) return null
  const isDraft = adjustment.status === 'draft'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Inventory control</p>
          <h2 className="text-2xl font-semibold text-slate-900">Adjustment detail</h2>
          <p className="text-sm text-slate-600">Review ledger corrections and audit history.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate('/inventory-adjustments')}>
            Back to list
          </Button>
          {adjustment.inventoryMovementId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/movements/${adjustment.inventoryMovementId}`)}
            >
              View movement
            </Button>
          )}
          {!isDraft && (
            <Button variant="secondary" size="sm" onClick={openCorrectionModal}>
              Correct / reverse
            </Button>
          )}
        </div>
      </div>

      {saveMessage && <Alert variant="success" title="Saved" message={saveMessage} />}
      {saveError && <Alert variant="error" title="Save failed" message={saveError} />}
      {postError && <Alert variant="error" title="Post failed" message={postError} />}
      {shortageDetails && shortageDetails.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">Insufficient usable stock</div>
          <div className="mt-1 text-xs text-amber-800">
            One or more adjustment lines would drive usable stock below zero.
          </div>
          <div className="mt-3 grid gap-2">
            {shortageDetails.map((line, index) => {
              const item = itemMap.get(line.itemId)
              const location = locationMap.get(line.locationId)
              const itemText = item ? `${item.sku} — ${item.name}` : line.itemId
              const locationText = location ? `${location.code} — ${location.name}` : line.locationId
              return (
                <div
                  key={`${line.itemId}-${line.locationId}-${line.uom}-${index}`}
                  className="rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-amber-900"
                >
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

      <Section title="Header">
        <Card>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                {statusBadge(adjustment)}
                {adjustment.correctedFromAdjustmentId && (
                  <Badge variant="info">Correction</Badge>
                )}
              </div>
              <div className="text-sm text-slate-700">
                <span className="font-semibold">Occurred:</span> {formatDate(adjustment.occurredAt)}
              </div>
              <div className="text-sm text-slate-700">
                <span className="font-semibold">Posted:</span>{' '}
                {movementQuery.data?.postedAt ? formatDate(movementQuery.data.postedAt) : '—'}
              </div>
              {adjustment.correctedFromAdjustmentId && (
                <div className="text-sm text-slate-700">
                  <span className="font-semibold">Corrects:</span>{' '}
                  <Link
                    className="text-brand-700 underline"
                    to={`/inventory-adjustments/${adjustment.correctedFromAdjustmentId}`}
                  >
                    {adjustment.correctedFromAdjustmentId}
                  </Link>
                </div>
              )}
            </div>
            <div className="space-y-2 text-sm text-slate-700">
              <div>
                <span className="font-semibold">Adjustment ID:</span> {adjustment.id}
              </div>
              <div>
                <span className="font-semibold">Notes:</span> {adjustment.notes || '—'}
              </div>
              {adjustment.inventoryMovementId && (
                <div>
                  <span className="font-semibold">Movement:</span>{' '}
                  <Link className="text-brand-700 underline" to={`/movements/${adjustment.inventoryMovementId}`}>
                    {adjustment.inventoryMovementId}
                  </Link>
                </div>
              )}
            </div>
          </div>
        </Card>
      </Section>

      {isDraft ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <Section title="Edit draft">
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
              </Card>
            </Section>

            <Section title="Lines">
              <AdjustmentLinesEditor
                lines={lines}
                itemOptions={itemOptions}
                itemLookup={itemMap}
                locationOptions={locationOptions}
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
                    {lines.length} line{lines.length === 1 ? '' : 's'}
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
                  <Button onClick={handlePost} disabled={postMutation.isPending}>
                    Post adjustment
                  </Button>
                  <Button variant="secondary" onClick={handleSaveDraft} disabled={updateMutation.isPending}>
                    Save draft
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={cancelMutation.isPending}
                  >
                    Cancel draft
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <>
          <Section title="Lines">
            <AdjustmentLinesTable lines={adjustment.lines ?? []} />
          </Section>

          <Section title="Totals by UOM">
            {totals.length === 0 ? (
              <Alert variant="info" title="No totals available" message="No line deltas were recorded." />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {totals.map((total) => {
                  const sign = total.quantityDelta > 0 ? '+' : total.quantityDelta < 0 ? '−' : ''
                  const tone = total.quantityDelta > 0 ? 'text-green-700' : total.quantityDelta < 0 ? 'text-red-600' : ''
                  return (
                    <Card key={total.uom}>
                      <div className="text-xs uppercase tracking-wide text-slate-500">UOM</div>
                      <div className="text-sm text-slate-600">{total.uom}</div>
                      <div className={`mt-2 text-lg font-semibold ${tone}`}>
                        {sign}
                        {formatNumber(Math.abs(total.quantityDelta))}
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </Section>
        </>
      )}

      <Section title="Audit trail">
        <Card>
          {auditQuery.isLoading && <div className="text-sm text-slate-600">Loading audit trail...</div>}
          {auditQuery.isError && (
            <Alert
              variant="error"
              title="Audit trail unavailable"
              message={(auditQuery.error as ApiError)?.message ?? 'Could not load audit trail.'}
            />
          )}
          {!auditQuery.isLoading && !auditQuery.isError && (
            <AuditTrailTable entries={auditQuery.data ?? []} />
          )}
        </Card>
      </Section>

      <Modal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        title="Cancel draft adjustment?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowCancelConfirm(false)}>
              Keep draft
            </Button>
            <Button variant="danger" onClick={() => cancelMutation.mutate()}>
              Cancel draft
            </Button>
          </div>
        }
      >
        Canceling a draft does not change inventory. Posted adjustments must be corrected via a reversal entry.
      </Modal>

      <Modal
        isOpen={showCorrectionModal}
        onClose={() => setShowCorrectionModal(false)}
        title="Correct adjustment"
      >
        <div className="space-y-4">
          <Alert
            variant="info"
            title="Posted adjustments are immutable"
            message="To correct inventory, post a reversing adjustment (and optionally create a replacement draft)."
          />
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Correction reason</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
            >
              {adjustmentReasonOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Occurred at</span>
            <Input
              type="datetime-local"
              value={correctionOccurredAt}
              onChange={(e) => setCorrectionOccurredAt(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
            <Textarea
              value={correctionNotes}
              onChange={(e) => setCorrectionNotes(e.target.value)}
              placeholder={`Reversal of adjustment ${adjustment.id}`}
            />
          </label>
          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Reverse lines</div>
            <div className="mt-2 space-y-2">
              {(adjustment.lines ?? []).map((line) => {
                const qty = line.quantityDelta ?? 0
                const sign = qty > 0 ? '+' : qty < 0 ? '−' : ''
                return (
                  <label key={line.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={correctionLineIds.has(line.id)}
                      onChange={(e) => {
                        setCorrectionLineIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(line.id)
                          else next.delete(line.id)
                          return next
                        })
                      }}
                    />
                    <span className="flex-1">
                      {line.itemSku || line.itemName || line.itemId} ·{' '}
                      {line.locationCode || line.locationName || line.locationId} · {sign}
                      {formatNumber(Math.abs(qty))} {line.uom}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={createReplacement}
              onChange={(e) => setCreateReplacement(e.target.checked)}
            />
            Create a replacement draft after posting the reversal
          </label>
          {correctionError && <Alert variant="error" title="Correction failed" message={correctionError} />}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCorrectionModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleCorrectionSubmit}>Post reversal</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
