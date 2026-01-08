/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiError, Item } from '../../../api/types'
import { createItem, updateItem, type ItemPayload } from '../api/items'
import { itemsQueryKeys } from '../queries'
import { useLocationsList } from '../../locations/queries'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { FormField } from '../../../components/FormField'

type Props = {
  initialItem?: Item
  onSuccess?: (item: Item) => void
  onCancel?: () => void
  title?: string
  autoFocusSku?: boolean
}

export function ItemForm({ initialItem, onSuccess, onCancel, title, autoFocusSku }: Props) {
  const isEdit = Boolean(initialItem?.id)
  const queryClient = useQueryClient()
  const [sku, setSku] = useState(initialItem?.sku ?? '')
  const [name, setName] = useState(initialItem?.name ?? '')
  const [description, setDescription] = useState(initialItem?.description ?? '')
  const [type, setType] = useState<Item['type']>(initialItem?.type ?? 'raw')
  const [isPhantom, setIsPhantom] = useState(initialItem?.isPhantom ?? false)
  const [lifecycleStatus, setLifecycleStatus] = useState<Item['lifecycleStatus']>(
    initialItem?.lifecycleStatus ?? 'Active',
  )
  const [defaultUom, setDefaultUom] = useState(initialItem?.defaultUom ?? '')
  const [defaultLocationId, setDefaultLocationId] = useState(initialItem?.defaultLocationId ?? '')
  const [standardCost, setStandardCost] = useState<string>(
    initialItem?.standardCost != null ? initialItem.standardCost.toString() : '',
  )

  useEffect(() => {
    if (!initialItem) return
    setSku(initialItem.sku)
    setName(initialItem.name)
    setDescription(initialItem.description ?? '')
    setType(initialItem.type ?? 'raw')
    setIsPhantom(initialItem.isPhantom ?? false)
    setLifecycleStatus(initialItem.lifecycleStatus ?? 'Active')
    setDefaultUom(initialItem.defaultUom ?? '')
    setDefaultLocationId(initialItem.defaultLocationId ?? '')
    setStandardCost(initialItem.standardCost != null ? initialItem.standardCost.toString() : '')
  }, [initialItem])

  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const mutation = useMutation<Item, ApiError, ItemPayload>({
    mutationFn: (payload) =>
      isEdit && initialItem?.id ? updateItem(initialItem.id, payload) : createItem(payload),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: itemsQueryKeys.all })
      onSuccess?.(item)
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const standardCostValue = standardCost.trim() ? Number(standardCost) : undefined
    mutation.mutate({
      sku,
      name,
      description: description || undefined,
      isPhantom,
      type,
      lifecycleStatus,
      defaultUom: defaultUom.trim() ? defaultUom.trim() : undefined,
      defaultLocationId: defaultLocationId || null,
      standardCost: standardCostValue,
    })
  }

  const locationOptions = locationsQuery.data?.data ?? []
  const selectedLocationMissing =
    Boolean(defaultLocationId) && !locationOptions.some((loc) => loc.id === defaultLocationId)

  return (
    <Card title={title ?? (isEdit ? 'Edit item' : 'Create item')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        {mutation.isError && (
          <Alert variant="error" title="Save failed" message={mutation.error.message} />
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="SKU" required>
            <Input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="ABC-123"
              required
              autoFocus={autoFocusSku}
              disabled={mutation.isPending}
            />
          </FormField>
          <FormField label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Widget"
              required
              disabled={mutation.isPending}
            />
          </FormField>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Type">
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as Item['type'])}
              disabled={mutation.isPending}
            >
              <option value="raw">Raw Material</option>
              <option value="wip">WIP</option>
              <option value="finished">Finished Good</option>
              <option value="packaging">Packaging</option>
            </select>
          </FormField>
          <div className="flex items-center h-full pt-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                checked={isPhantom}
                onChange={(e) => setIsPhantom(e.target.checked)}
                disabled={mutation.isPending}
              />
              <span className="text-slate-700">Phantom Item</span>
            </label>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Status">
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={lifecycleStatus}
              onChange={(e) => setLifecycleStatus(e.target.value as Item['lifecycleStatus'])}
              disabled={mutation.isPending}
            >
              <option value="Active">Active</option>
              <option value="In-Development">In-Development</option>
              <option value="Phase-Out">Phase-Out</option>
              <option value="Obsolete">Obsolete</option>
            </select>
          </FormField>
          <FormField label="Default UOM">
            <Input
              value={defaultUom}
              onChange={(e) => setDefaultUom(e.target.value)}
              placeholder="ea, kg, box"
              disabled={mutation.isPending}
            />
          </FormField>
          <FormField label="Standard Cost" helper="Per unit cost for valuation (optional)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={standardCost}
              onChange={(e) => setStandardCost(e.target.value)}
              placeholder="0.00"
              disabled={mutation.isPending}
            />
          </FormField>
        </div>
        <FormField label="Default location" className="block">
          <select
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={defaultLocationId}
            onChange={(e) => setDefaultLocationId(e.target.value)}
            disabled={mutation.isPending || locationsQuery.isLoading}
          >
            <option value="">No default</option>
            {locationOptions.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.code || loc.name || loc.id}
              </option>
            ))}
            {selectedLocationMissing && defaultLocationId && (
              <option value={defaultLocationId}>
                {initialItem?.defaultLocationCode ||
                  initialItem?.defaultLocationName ||
                  defaultLocationId}
              </option>
            )}
          </select>
          {locationsQuery.isError && (
            <p className="text-xs text-red-600">
              {(locationsQuery.error?.message || 'Could not load locations. You can still save without one.')}
            </p>
          )}
        </FormField>
        <FormField label="Description" className="block">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional details"
            disabled={mutation.isPending}
          />
        </FormField>
        <div className="flex gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCancel}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            {isEdit ? 'Save changes' : 'Create item'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
