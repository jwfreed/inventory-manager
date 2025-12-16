import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import type { ApiError } from '../../../api/types'
import { createBom, type BomCreatePayload } from '../../../api/endpoints/boms'

type Props = {
  outputItemId: string
  defaultUom?: string
  onSuccess?: () => void
}

type ComponentDraft = {
  lineNumber: number
  componentItemId: string
  uom: string
  quantityPer: number | ''
  scrapFactor?: number | ''
  notes?: string
}

export function BomForm({ outputItemId, defaultUom, onSuccess }: Props) {
  const [bomCode, setBomCode] = useState('')
  const [yieldUom, setYieldUom] = useState(defaultUom ?? '')
  const [defaultBomUom, setDefaultBomUom] = useState(defaultUom ?? '')
  const [yieldQuantity, setYieldQuantity] = useState<number | ''>(1)
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [notes, setNotes] = useState('')
  const [components, setComponents] = useState<ComponentDraft[]>([
    { lineNumber: 1, componentItemId: '', uom: defaultUom ?? '', quantityPer: '' },
  ])

  const mutation = useMutation({
    mutationFn: (payload: BomCreatePayload) => createBom(payload),
    onSuccess: () => {
      setBomCode('')
      setYieldUom(defaultUom ?? '')
      setDefaultBomUom(defaultUom ?? '')
      setYieldQuantity(1)
      setEffectiveFrom('')
      setNotes('')
      setComponents([{ lineNumber: 1, componentItemId: '', uom: defaultUom ?? '', quantityPer: '' }])
      onSuccess?.()
    },
  })

  const addComponent = () =>
    setComponents((prev) => [
      ...prev,
      { lineNumber: prev.length + 1, componentItemId: '', uom: defaultUom ?? '', quantityPer: '' },
    ])

  const updateComponent = (index: number, patch: Partial<ComponentDraft>) => {
    setComponents((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const removeComponent = (index: number) => {
    setComponents((prev) => prev.filter((_, i) => i !== index).map((c, idx) => ({ ...c, lineNumber: idx + 1 })))
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!bomCode || !yieldUom || !defaultBomUom) return
    const cleanComponents = components.filter(
      (c) => c.componentItemId && c.uom && c.quantityPer !== '' && Number(c.quantityPer) > 0,
    )
    if (cleanComponents.length === 0) return
    mutation.mutate({
      bomCode,
      outputItemId,
      defaultUom: defaultBomUom,
      notes: notes || undefined,
      version: {
        versionNumber: 1,
        effectiveFrom: effectiveFrom || undefined,
        yieldQuantity: Number(yieldQuantity || 0) || 1,
        yieldUom,
        components: cleanComponents.map((c, idx) => ({
          lineNumber: c.lineNumber || idx + 1,
          componentItemId: c.componentItemId,
          uom: c.uom,
          quantityPer: Number(c.quantityPer),
          scrapFactor: c.scrapFactor === '' ? undefined : c.scrapFactor,
          notes: c.notes || undefined,
        })),
      },
    })
  }

  return (
    <Card title="Create BOM" description="Define components and first version for this item.">
      <form className="space-y-4" onSubmit={onSubmit}>
        {mutation.isError && (
          <Alert variant="error" title="Create failed" message={(mutation.error as ApiError).message} />
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">BOM code</span>
            <Input
              value={bomCode}
              onChange={(e) => setBomCode(e.target.value)}
              placeholder="BOM-001"
              required
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Default UOM</span>
            <Input
              value={defaultBomUom}
              onChange={(e) => setDefaultBomUom(e.target.value)}
              placeholder="ea"
              required
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Yield UOM</span>
            <Input
              value={yieldUom}
              onChange={(e) => setYieldUom(e.target.value)}
              placeholder="ea"
              required
              disabled={mutation.isPending}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Yield quantity</span>
            <Input
              type="number"
              min={0}
              value={yieldQuantity}
              onChange={(e) =>
                setYieldQuantity(e.target.value === '' ? '' : Number(e.target.value))
              }
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">Effective from</span>
            <Input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              disabled={mutation.isPending}
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              disabled={mutation.isPending}
            />
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">Components</div>
          <Button type="button" variant="secondary" size="sm" onClick={addComponent} disabled={mutation.isPending}>
            Add component
          </Button>
        </div>
        <div className="space-y-3">
          {components.map((line, idx) => (
            <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-6">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Line #</span>
                <Input
                  type="number"
                  min={1}
                  value={line.lineNumber}
                  onChange={(e) =>
                    updateComponent(idx, {
                      lineNumber: e.target.value ? Number(e.target.value) : idx + 1,
                    })
                  }
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Component Item ID</span>
                <Input
                  value={line.componentItemId}
                  onChange={(e) => updateComponent(idx, { componentItemId: e.target.value })}
                  placeholder="Item UUID"
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                <Input
                  value={line.uom}
                  onChange={(e) => updateComponent(idx, { uom: e.target.value })}
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Qty per</span>
                <Input
                  type="number"
                  min={0}
                  value={line.quantityPer}
                  onChange={(e) =>
                    updateComponent(idx, {
                      quantityPer: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Scrap factor</span>
                <Input
                  type="number"
                  min={0}
                  value={line.scrapFactor ?? ''}
                  onChange={(e) =>
                    updateComponent(idx, {
                      scrapFactor: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-3">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={line.notes || ''}
                  onChange={(e) => updateComponent(idx, { notes: e.target.value })}
                  disabled={mutation.isPending}
                />
              </label>
              {components.length > 1 && (
                <div className="md:col-span-6 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => removeComponent(idx)}
                    disabled={mutation.isPending}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            Create BOM
          </Button>
        </div>
      </form>
    </Card>
  )
}
