import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError, InventoryCount, Location } from '@api/types'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Alert, Button, LoadingSpinner, Modal, PageHeader, Panel } from '@shared/ui'
import { postInventoryCount, updateInventoryCount } from '../api/counts'
import {
  InventoryCountForm,
  type InventoryCountFormValues,
  createEmptyInventoryCountLine,
} from '../components/InventoryCountForm'
import { inventoryQueryKeys, useInventoryCount } from '../queries'

function buildWarehouseOptions(locations: Location[]) {
  const warehouseRoots = locations.filter((location) => location.type === 'warehouse')
  if (warehouseRoots.length > 0) {
    return warehouseRoots.map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`,
    }))
  }
  const seen = new Set<string>()
  return locations
    .filter((location) => {
      if (!location.warehouseId || seen.has(location.warehouseId)) return false
      seen.add(location.warehouseId)
      return true
    })
    .map((location) => ({
      value: location.warehouseId as string,
      label: location.warehouseId as string,
    }))
}

function toDateTimeLocal(value?: string | null) {
  const source = value ? new Date(value) : new Date()
  const offset = source.getTimezoneOffset()
  return new Date(source.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

function mapCountToFormValues(count: InventoryCount): InventoryCountFormValues {
  return {
    countedAt: toDateTimeLocal(count.countedAt),
    warehouseId: count.warehouseId,
    locationId: count.locationId ?? '',
    notes: count.notes ?? '',
    lines:
      count.lines.length > 0
        ? count.lines.map((line, index) => ({
            lineNumber: line.lineNumber ?? index + 1,
            itemId: line.itemId,
            locationId: line.locationId,
            uom: line.uom,
            countedQuantity: String(line.countedQuantity ?? ''),
            unitCostForPositiveAdjustment:
              line.unitCostForPositiveAdjustment != null
                ? String(line.unitCostForPositiveAdjustment)
                : '',
            reasonCode: line.reasonCode ?? '',
            notes: line.notes ?? '',
          }))
        : [createEmptyInventoryCountLine(1)],
  }
}

function formatError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export default function InventoryCountDetailPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const countQuery = useInventoryCount(id)
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })
  const itemsQuery = useItemsList({ lifecycleStatus: 'Active', limit: 500 }, { staleTime: 60_000 })

  const [formValues, setFormValues] = useState<InventoryCountFormValues>({
    countedAt: toDateTimeLocal(),
    warehouseId: '',
    locationId: '',
    notes: '',
    lines: [createEmptyInventoryCountLine(1)],
  })
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showPostConfirm, setShowPostConfirm] = useState(false)

  useEffect(() => {
    if (countQuery.data) {
      setFormValues(mapCountToFormValues(countQuery.data))
    }
  }, [countQuery.data])

  const warehouseOptions = useMemo(
    () => buildWarehouseOptions(locationsQuery.data?.data ?? []),
    [locationsQuery.data],
  )
  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? [])
        .filter((location) => location.type !== 'warehouse' && location.warehouseId === formValues.warehouseId)
        .map((location) => ({
          value: location.id,
          label: `${location.code} — ${location.name}`,
          keywords: `${location.code} ${location.name} ${location.type}`,
        })),
    [formValues.warehouseId, locationsQuery.data],
  )
  const itemOptions = useMemo(
    () =>
      (itemsQuery.data?.data ?? []).map((item) => ({
        value: item.id,
        label: item.sku ? `${item.sku} — ${item.name}` : item.name,
        keywords: `${item.sku ?? ''} ${item.name}`,
      })),
    [itemsQuery.data],
  )

  const isLocked = countQuery.data?.status !== 'draft'

  const saveMutation = useMutation({
    mutationFn: () =>
      updateInventoryCount(id as string, {
        countedAt: new Date(formValues.countedAt).toISOString(),
        notes: formValues.notes.trim() || undefined,
        lines: formValues.lines.map((line, index) => ({
          lineNumber: index + 1,
          itemId: line.itemId,
          locationId: line.locationId || formValues.locationId,
          uom: line.uom,
          countedQuantity: Number(line.countedQuantity),
          unitCostForPositiveAdjustment: line.unitCostForPositiveAdjustment
            ? Number(line.unitCostForPositiveAdjustment)
            : undefined,
          reasonCode: line.reasonCode.trim() || undefined,
          notes: line.notes.trim() || undefined,
        })),
      }),
    onSuccess: async (updated) => {
      setSaveError(null)
      setSaveMessage('Inventory count saved.')
      queryClient.setQueryData(inventoryQueryKeys.countsDetail(updated.id), updated)
      await queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.countsList({ warehouseId: updated.warehouseId }) })
    },
    onError: (err) => {
      setSaveMessage(null)
      setSaveError(formatError(err, 'Failed to update inventory count.'))
    },
  })

  const postMutation = useMutation({
    mutationFn: () => postInventoryCount(id as string, { warehouseId: formValues.warehouseId }),
    onSuccess: async (updated) => {
      setSaveError(null)
      setSaveMessage('Inventory count posted.')
      setShowPostConfirm(false)
      queryClient.setQueryData(inventoryQueryKeys.countsDetail(updated.id), updated)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.countsList({ warehouseId: updated.warehouseId }) }),
        queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.all }),
      ])
    },
    onError: (err) => {
      setSaveMessage(null)
      setSaveError(formatError(err, 'Failed to post inventory count.'))
    },
  })

  if (countQuery.isLoading) {
    return <LoadingSpinner label="Loading inventory count..." />
  }

  if (countQuery.isError || !countQuery.data) {
    return (
      <Alert
        variant="error"
        title="Inventory count unavailable"
        message={formatError(countQuery.error, 'Failed to load inventory count.')}
      />
    )
  }

  const count = countQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Inventory count ${count.id}`}
        subtitle="Draft counts remain editable until they are posted."
        action={
          <div className="flex gap-2">
            <Link to="/inventory-counts">
              <Button size="sm" variant="secondary">
                Back to list
              </Button>
            </Link>
            {count.inventoryMovementId ? (
              <Link to={`/movements/${count.inventoryMovementId}`}>
                <Button size="sm" variant="secondary">
                  View movement
                </Button>
              </Link>
            ) : null}
          </div>
        }
      />
      <Panel
        title="Count summary"
        description={`Status: ${count.status}. Variance lines: ${count.summary.linesWithVariance}.`}
      >
        {saveMessage ? <Alert variant="success" title="Inventory count updated" message={saveMessage} /> : null}
        {saveError ? <Alert variant="error" title="Inventory count error" message={saveError} /> : null}
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Lines</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{count.summary.lineCount}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Abs variance</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{count.summary.totalAbsVariance}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Hit rate</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">
              {(count.summary.hitRate * 100).toFixed(1)}%
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Weighted accuracy</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">
              {(count.summary.weightedAccuracyPct * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Count details" description={isLocked ? 'Posted and canceled counts are read-only.' : 'Edit draft lines before posting.'}>
        <InventoryCountForm
          value={formValues}
          warehouseOptions={warehouseOptions}
          itemOptions={itemOptions}
          locationOptions={locationOptions}
          isLocked={isLocked}
          isSubmitting={saveMutation.isPending}
          submitLabel="Save draft"
          onChange={(field, nextValue) =>
            setFormValues((current) => ({
              ...current,
              [field]: nextValue,
            }))
          }
          onLineChange={(lineIndex, field, nextValue) =>
            setFormValues((current) => ({
              ...current,
              lines: current.lines.map((line, index) =>
                index === lineIndex
                  ? {
                      ...line,
                      [field]: nextValue,
                      ...(field === 'itemId'
                        ? {
                            uom:
                              (itemsQuery.data?.data ?? []).find((item) => item.id === nextValue)
                                ?.stockingUom ??
                              (itemsQuery.data?.data ?? []).find((item) => item.id === nextValue)
                                ?.defaultUom ??
                              line.uom,
                          }
                        : {}),
                    }
                  : line,
              ),
            }))
          }
          onAddLine={() =>
            setFormValues((current) => ({
              ...current,
              lines: [...current.lines, createEmptyInventoryCountLine(current.lines.length + 1)],
            }))
          }
          onRemoveLine={(lineIndex) =>
            setFormValues((current) => ({
              ...current,
              lines: current.lines
                .filter((_, index) => index !== lineIndex)
                .map((line, index) => ({ ...line, lineNumber: index + 1 })),
            }))
          }
          onSubmit={() => {
            setSaveError(null)
            setSaveMessage(null)
            saveMutation.mutate()
          }}
        />
        {!isLocked ? (
          <div className="mt-4 flex justify-end">
            <Button
              size="sm"
              onClick={() => setShowPostConfirm(true)}
              disabled={postMutation.isPending}
            >
              Post count
            </Button>
          </div>
        ) : null}
      </Panel>

      <Modal
        isOpen={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        title="Post inventory count?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowPostConfirm(false)}>
              Keep draft
            </Button>
            <Button size="sm" onClick={() => postMutation.mutate()} disabled={postMutation.isPending}>
              {postMutation.isPending ? 'Posting...' : 'Confirm post'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>Posting creates the authoritative inventory adjustment for this count.</p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
            <div>Lines with variance: {count.summary.linesWithVariance}</div>
            <div>Total absolute variance: {count.summary.totalAbsVariance}</div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
