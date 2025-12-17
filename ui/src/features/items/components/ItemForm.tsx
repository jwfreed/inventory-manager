/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ApiError, Item } from '../../../api/types'
import { createItem, updateItem, type ItemPayload } from '../../../api/endpoints/items'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'

type Props = {
  initialItem?: Item
  onSuccess?: (item: Item) => void
  onCancel?: () => void
  title?: string
}

export function ItemForm({ initialItem, onSuccess, onCancel, title }: Props) {
  const isEdit = Boolean(initialItem?.id)
  const [sku, setSku] = useState(initialItem?.sku ?? '')
  const [name, setName] = useState(initialItem?.name ?? '')
  const [description, setDescription] = useState(initialItem?.description ?? '')
  const [active, setActive] = useState(initialItem?.active ?? true)

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (!initialItem) return
    setSku(initialItem.sku)
    setName(initialItem.name)
    setDescription(initialItem.description ?? '')
    setActive(initialItem.active)
  }, [initialItem])

  const mutation = useMutation<Item, ApiError, ItemPayload>({
    mutationFn: (payload) =>
      isEdit && initialItem?.id ? updateItem(initialItem.id, payload) : createItem(payload),
    onSuccess: (item) => {
      onSuccess?.(item)
    },
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    mutation.mutate({
      sku,
      name,
      description: description || undefined,
      active,
    })
  }

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
