import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError } from '@api/types'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Alert, Button, PageHeader, Panel } from '@shared/ui'
import { createInventoryTransfer } from '../api/transfers'
import { InventoryTransferForm, type InventoryTransferFormValues } from '../components/InventoryTransferForm'
import { inventoryQueryKeys } from '../queries'

function formatError(err: unknown, fallback: string) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err instanceof Error && err.message) return err.message
  const apiErr = err as ApiError
  if (typeof apiErr?.message === 'string') return apiErr.message
  return fallback
}

function createInitialValues(): InventoryTransferFormValues {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  const local = new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 16)
  return {
    itemId: '',
    sourceLocationId: '',
    destinationLocationId: '',
    quantity: '',
    uom: '',
    occurredAt: local,
    reasonCode: 'transfer',
    notes: '',
  }
}

export function InventoryTransferCreatePage() {
  const queryClient = useQueryClient()
  const [formValues, setFormValues] = useState<InventoryTransferFormValues>(() => createInitialValues())
  const [submitError, setSubmitError] = useState<string | null>(null)

  const itemsQuery = useItemsList({ lifecycleStatus: 'Active', limit: 500 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 1000 }, { staleTime: 60_000 })

  const itemOptions = useMemo(
    () =>
      (itemsQuery.data?.data ?? []).map((item) => ({
        value: item.id,
        label: item.sku ? `${item.sku} — ${item.name}` : item.name,
        keywords: `${item.sku ?? ''} ${item.name}`,
      })),
    [itemsQuery.data],
  )

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? [])
        .filter((location) => location.type !== 'warehouse')
        .map((location) => ({
          value: location.id,
          label: `${location.code} — ${location.name}`,
          keywords: `${location.code} ${location.name} ${location.type}`,
        })),
    [locationsQuery.data],
  )

  const selectedItem = useMemo(
    () => (itemsQuery.data?.data ?? []).find((item) => item.id === formValues.itemId),
    [formValues.itemId, itemsQuery.data],
  )

  const transferMutation = useMutation({
    mutationFn: () =>
      createInventoryTransfer({
        itemId: formValues.itemId,
        sourceLocationId: formValues.sourceLocationId,
        destinationLocationId: formValues.destinationLocationId,
        quantity: Number(formValues.quantity),
        uom: formValues.uom,
        occurredAt: formValues.occurredAt ? new Date(formValues.occurredAt).toISOString() : undefined,
        reasonCode: formValues.reasonCode.trim() || undefined,
        notes: formValues.notes.trim() || undefined,
      }),
    onSuccess: async () => {
      setSubmitError(null)
      await queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.all })
    },
    onError: (err) => {
      setSubmitError(formatError(err, 'Failed to post inventory transfer.'))
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory transfer"
        subtitle="Post one authoritative location-to-location transfer."
        action={
          <Link to="/inventory-counts">
            <Button variant="secondary" size="sm">
              Inventory counts
            </Button>
          </Link>
        }
      />
      <Panel
        title="Transfer details"
        description="Use this screen for direct operational transfers. Negative overrides are intentionally unavailable."
      >
        {submitError ? <Alert variant="error" title="Transfer failed" message={submitError} /> : null}
        {transferMutation.isSuccess ? (
          <Alert
            variant="success"
            title="Transfer posted"
            message="Inventory transfer posted successfully."
            action={
              <div className="flex flex-wrap gap-2">
                {transferMutation.data?.movementId ? (
                  <Link to={`/movements/${transferMutation.data.movementId}`}>
                    <Button size="sm" variant="secondary">
                      View movement
                    </Button>
                  </Link>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFormValues(createInitialValues())
                    transferMutation.reset()
                  }}
                >
                  New transfer
                </Button>
              </div>
            }
          />
        ) : null}
        <InventoryTransferForm
          value={{
            ...formValues,
            uom: formValues.uom || selectedItem?.stockingUom || selectedItem?.defaultUom || '',
          }}
          itemOptions={itemOptions}
          locationOptions={locationOptions}
          isSubmitting={transferMutation.isPending}
          onChange={(field, nextValue) =>
            setFormValues((current) => ({
              ...current,
              [field]: nextValue,
              ...(field === 'itemId'
                ? {
                    uom:
                      (itemsQuery.data?.data ?? []).find((item) => item.id === nextValue)?.stockingUom ??
                      (itemsQuery.data?.data ?? []).find((item) => item.id === nextValue)?.defaultUom ??
                      current.uom,
                  }
                : {}),
            }))
          }
          onSubmit={() => {
            setSubmitError(null)
            transferMutation.mutate()
          }}
        />
      </Panel>
    </div>
  )
}
