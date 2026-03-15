import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Button, PageHeader } from '@shared/ui'
import { createInventoryTransfer } from '../api/transfers'
import { InventoryTransferForm, type InventoryTransferFormValues } from '../components/InventoryTransferForm'
import { TransferOperationPanel } from '../components/TransferOperationPanel'
import { inventoryQueryKeys } from '../queries'
import { ledgerQueryKeys } from '@features/ledger/queries'
import { formatTransferOperationError } from '../lib/inventoryOperationErrorMessaging'
import { logOperationalMutationFailure } from '../../../lib/operationalLogging'

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
  const [validationMessages, setValidationMessages] = useState<string[]>([])

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
      setValidationMessages([])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: ledgerQueryKeys.all }),
      ])
    },
    onError: (err) => {
      logOperationalMutationFailure('inventory-transfers', 'create-transfer', err, {
        itemId: formValues.itemId,
        sourceLocationId: formValues.sourceLocationId,
        destinationLocationId: formValues.destinationLocationId,
      })
      setSubmitError(formatTransferOperationError(err, 'Failed to post inventory transfer.'))
    },
  })

  const validateTransferForm = () => {
    const errors: string[] = []
    if (!formValues.itemId) errors.push('Select an item before posting the transfer.')
    if (!formValues.sourceLocationId) errors.push('Select a source location.')
    if (!formValues.destinationLocationId) errors.push('Select a destination location.')
    if (
      formValues.sourceLocationId &&
      formValues.destinationLocationId &&
      formValues.sourceLocationId === formValues.destinationLocationId
    ) {
      errors.push('Source and destination locations must differ.')
    }
    if (!(Number(formValues.quantity) > 0)) {
      errors.push('Transfer quantity must be greater than zero.')
    }
    if (!formValues.uom.trim()) {
      errors.push('Enter a unit of measure before posting the transfer.')
    }
    return errors
  }

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
      <TransferOperationPanel
        validationMessages={validationMessages}
        errorMessage={submitError}
        result={transferMutation.data ?? null}
        onReset={() => {
          setFormValues(createInitialValues())
          setSubmitError(null)
          setValidationMessages([])
          transferMutation.reset()
        }}
      >
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
            const nextValidationMessages = validateTransferForm()
            setValidationMessages(nextValidationMessages)
            if (nextValidationMessages.length > 0) {
              setSubmitError(null)
              return
            }
            setSubmitError(null)
            transferMutation.mutate()
          }}
        />
      </TransferOperationPanel>
    </div>
  )
}
