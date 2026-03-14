import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError, Location } from '@api/types'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Alert, PageHeader, Panel } from '@shared/ui'
import { createInventoryCount } from '../api/counts'
import {
  InventoryCountForm,
  createEmptyInventoryCountLine,
  type InventoryCountFormValues,
} from '../components/InventoryCountForm'
import { inventoryQueryKeys } from '../queries'

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

function formatError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

export default function InventoryCountCreatePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })
  const itemsQuery = useItemsList({ lifecycleStatus: 'Active', limit: 500 }, { staleTime: 60_000 })

  const warehouseOptions = useMemo(
    () => buildWarehouseOptions(locationsQuery.data?.data ?? []),
    [locationsQuery.data],
  )

  const [formValues, setFormValues] = useState<InventoryCountFormValues>({
    countedAt: toDateTimeLocal(),
    warehouseId: '',
    locationId: '',
    notes: '',
    lines: [createEmptyInventoryCountLine(1)],
  })

  useEffect(() => {
    if (!formValues.warehouseId && warehouseOptions[0]?.value) {
      setFormValues((current) => ({ ...current, warehouseId: warehouseOptions[0].value }))
    }
  }, [formValues.warehouseId, warehouseOptions])

  const warehouseLocationOptions = useMemo(
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

  const createMutation = useMutation({
    mutationFn: () =>
      createInventoryCount({
        countedAt: new Date(formValues.countedAt).toISOString(),
        warehouseId: formValues.warehouseId,
        locationId: formValues.locationId || undefined,
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
    onSuccess: async (count) => {
      setSubmitError(null)
      await queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.countsListRoot })
      navigate(`/inventory-counts/${count.id}`)
    },
    onError: (err) => {
      setSubmitError(formatError(err, 'Failed to create inventory count.'))
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="New inventory count"
        subtitle="Create a draft count before posting inventory adjustments."
      />
      <Panel title="Count draft" description="Draft counts stay editable until posted.">
        {submitError ? <Alert variant="error" title="Create failed" message={submitError} /> : null}
        <InventoryCountForm
          value={formValues}
          warehouseOptions={warehouseOptions}
          itemOptions={itemOptions}
          locationOptions={warehouseLocationOptions}
          isSubmitting={createMutation.isPending}
          submitLabel="Create count"
          onChange={(field, nextValue) =>
            setFormValues((current) => ({
              ...current,
              [field]: nextValue,
              ...(field === 'warehouseId'
                ? {
                    locationId: '',
                    lines: current.lines.map((line) => ({ ...line, locationId: '' })),
                  }
                : {}),
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
            setSubmitError(null)
            createMutation.mutate()
          }}
        />
      </Panel>
    </div>
  )
}
