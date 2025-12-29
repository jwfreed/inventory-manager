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
  const [defaultUom, setDefaultUom] = useState(initialItem?.defaultUom ?? '')
  const [defaultLocationId, setDefaultLocationId] = useState(initialItem?.defaultLocationId ?? '')
  const [active, setActive] = useState(initialItem?.active ?? true)

  useEffect(() => {
    if (!initialItem) return
    setSku(initialItem.sku)
    setName(initialItem.name)
    setDescription(initialItem.description ?? '')
    setType(initialItem.type ?? 'raw')
    setDefaultUom(initialItem.defaultUom ?? '')
    setDefaultLocationId(initialItem.defaultLocationId ?? '')
    setActive(initialItem.active)
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
    mutation.mutate({
      sku,
      name,
      description: description || undefined,
      type,
      defaultUom: defaultUom.trim() ? defaultUom.trim() : undefined,
      defaultLocationId: defaultLocationId || null,
      active,
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
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">SKU</span>
            <Input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="ABC-123"
              required
              autoFocus={autoFocusSku}
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Widget"
              required
              disabled={mutation.isPending}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Type</span>
            <select
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as Item['type'])}
              disabled={mutation.isPending}
            >
              <option value="raw">Raw material</option>
              <option value="wip">Work in progress</option>
              <option value="finished">Finished good</option>
              <option value="packaging">Packaging</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default UOM</span>
            <Input
              value={defaultUom}
              onChange={(e) => setDefaultUom(e.target.value)}
              placeholder="ea, kg, box"
              disabled={mutation.isPending}
            />
          </label>
        </div>
        <label className="space-y-1 text-sm block">
          <span className="text-xs uppercase tracking-wide text-slate-500">Default location</span>
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
        </label>
        <label className="space-y-1 text-sm block">
          <span className="text-xs uppercase tracking-wide text-slate-500">Description</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional details"
            disabled={mutation.isPending}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            disabled={mutation.isPending}
          />
          <span>Active</span>
        </label>
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
