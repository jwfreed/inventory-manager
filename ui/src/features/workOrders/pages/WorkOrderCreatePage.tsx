/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createWorkOrder, type WorkOrderCreatePayload } from '../../../api/endpoints/workOrders'
import { listBomsByItem } from '../../../api/endpoints/boms'
import { listItems } from '../../../api/endpoints/items'
import { listLocations } from '../../../api/endpoints/locations'
import type { ApiError, Bom, Item } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Combobox } from '../../../components/Combobox'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'

const formatError = (err: unknown): string => {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object' && 'message' in (err as { message?: unknown }) && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return 'Unknown error'
  }
}

export default function WorkOrderCreatePage() {
  const navigate = useNavigate()
  const [workOrderNumber, setWorkOrderNumber] = useState('')
  const [outputItemId, setOutputItemId] = useState('')
  const [outputUom, setOutputUom] = useState('')
  const [quantityPlanned, setQuantityPlanned] = useState<number | ''>(1)
  const [scheduledStartAt, setScheduledStartAt] = useState('')
  const [scheduledDueAt, setScheduledDueAt] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [defaultConsumeLocationId, setDefaultConsumeLocationId] = useState('')
  const [defaultProduceLocationId, setDefaultProduceLocationId] = useState('')
  const [quantityError, setQuantityError] = useState<string | null>(null)

  const itemsQuery = useQuery({
    queryKey: ['items', 'wo-create'],
    queryFn: () => listItems({ limit: 200 }),
    staleTime: 1000 * 60,
  })

  const locationsQuery = useQuery({
    queryKey: ['locations', 'wo-create'],
    queryFn: () => listLocations({ limit: 200, active: true }),
    staleTime: 1000 * 60,
  })

  const bomsQuery = useQuery({
    queryKey: ['item-boms', outputItemId],
    queryFn: () => listBomsByItem(outputItemId),
    enabled: !!outputItemId,
  })

  const itemsById = useMemo(() => {
    const map = new Map<string, Item>()
    itemsQuery.data?.data?.forEach((item) => map.set(item.id, item))
    return map
  }, [itemsQuery.data])

  const locationOptions = useMemo(
    () =>
      (locationsQuery.data?.data ?? []).map((loc) => ({
        value: loc.id,
        label: `${loc.code} — ${loc.name}`,
      })),
    [locationsQuery.data],
  )

  const bomOptions = useMemo(
    () =>
      (bomsQuery.data?.boms ?? []).map((bom) => ({
        value: bom.id,
        label: bom.bomCode,
        description: bom.defaultUom ? `Default UOM: ${bom.defaultUom}` : undefined,
        keywords: `${bom.bomCode} ${bom.defaultUom ?? ''}`.trim(),
      })),
    [bomsQuery.data],
  )

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const item = itemsById.get(outputItemId)
    if (!item) return
    setOutputUom((prev) => prev || item.defaultUom || '')
    setDefaultConsumeLocationId((prev) => (prev ? prev : item.defaultLocationId ?? ''))
    setDefaultProduceLocationId((prev) => (prev ? prev : item.defaultLocationId ?? ''))
  }, [itemsById, outputItemId])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const bomDefault = bomsQuery.data?.boms?.[0]
    if (bomDefault) {
      setSelectedBomId((prev) => prev || bomDefault.id)
      const version = bomDefault.versions.find((v) => v.status === 'active') ?? bomDefault.versions[0]
      if (version) {
        setSelectedVersionId(version.id)
        setOutputUom((prev) => prev || version.yieldUom || bomDefault.defaultUom)
      } else {
        setOutputUom((prev) => prev || bomDefault.defaultUom)
      }
    } else {
      setSelectedBomId('')
      setSelectedVersionId('')
    }
  }, [bomsQuery.data])

  const mutation = useMutation({
    mutationFn: (payload: WorkOrderCreatePayload) => createWorkOrder(payload),
    onSuccess: (wo) => {
      navigate(`/work-orders/${wo.id}`)
    },
  })

  const selectedBom: Bom | undefined = useMemo(
    () => bomsQuery.data?.boms.find((b) => b.id === selectedBomId),
    [bomsQuery.data, selectedBomId],
  )
  const selectedItem = itemsById.get(outputItemId)

  const consumeMissing =
    Boolean(defaultConsumeLocationId) &&
    !locationOptions.some((opt) => opt.value === defaultConsumeLocationId)
  const produceMissing =
    Boolean(defaultProduceLocationId) &&
    !locationOptions.some((opt) => opt.value === defaultProduceLocationId)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setQuantityError(null)
    if (!workOrderNumber || !selectedBomId || !outputItemId || !outputUom || quantityPlanned === '') {
      return
    }
    if (!(Number(quantityPlanned) > 0)) {
      setQuantityError('Quantity planned must be greater than 0.')
      return
    }
    const toDateTime = (value: string) => (value ? `${value}T00:00:00.000Z` : undefined)
    const start = toDateTime(scheduledStartAt)
    const due = toDateTime(scheduledDueAt)

    mutation.mutate({
      workOrderNumber,
      bomId: selectedBomId,
      bomVersionId: selectedVersionId || undefined,
      outputItemId,
      outputUom,
      quantityPlanned: Number(quantityPlanned),
      defaultConsumeLocationId: defaultConsumeLocationId || undefined,
      defaultProduceLocationId: defaultProduceLocationId || undefined,
      scheduledStartAt: start || undefined,
      scheduledDueAt: due || undefined,
      notes: notes || undefined,
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Execution</p>
          <h2 className="text-2xl font-semibold text-slate-900">Create Work Order</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/work-orders')}>
          Back to list
        </Button>
      </div>

      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          {mutation.isError && (
            <Alert variant="error" title="Create failed" message={formatError(mutation.error as ApiError)} />
          )}
          <Section title="Header">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Work order number</span>
                <Input
                  value={workOrderNumber}
                  onChange={(e) => setWorkOrderNumber(e.target.value)}
                  required
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
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Item to make</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={outputItemId}
                  onChange={(e) => {
                    setOutputItemId(e.target.value)
                    setSelectedBomId('')
                    setSelectedVersionId('')
                  }}
                  disabled={mutation.isPending || itemsQuery.isLoading}
                >
                  <option value="">Select item</option>
                  {itemsQuery.data?.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sku} — {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Unit of measure</span>
                <Input
                  value={outputUom}
                  onChange={(e) => setOutputUom(e.target.value)}
                  placeholder="ea"
                  required
                  disabled={mutation.isPending}
                />
                {selectedItem?.defaultUom && outputUom === selectedItem.defaultUom && (
                  <p className="text-xs text-slate-500">Auto from item default UOM</p>
                )}
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Quantity planned</span>
                <Input
                  type="number"
                  min={1}
                  value={quantityPlanned}
                  onChange={(e) => {
                    const next = e.target.value === '' ? '' : Number(e.target.value)
                    setQuantityPlanned(next)
                    if (quantityError) setQuantityError(null)
                  }}
                  required
                  disabled={mutation.isPending}
                />
                {quantityError ? <p className="text-xs text-red-600">{quantityError}</p> : null}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Scheduled start</span>
                <Input
                  type="date"
                  value={scheduledStartAt}
                  onChange={(e) => setScheduledStartAt(e.target.value)}
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Scheduled due</span>
                <Input
                  type="date"
                  value={scheduledDueAt}
                  onChange={(e) => setScheduledDueAt(e.target.value)}
                  disabled={mutation.isPending}
                />
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Default consume location</span>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={defaultConsumeLocationId}
                  onChange={(e) => setDefaultConsumeLocationId(e.target.value)}
                  disabled={mutation.isPending || locationsQuery.isLoading}
                >
                  <option value="">None</option>
                  {locationOptions.map((loc) => (
                    <option key={loc.value} value={loc.value}>
                      {loc.label}
                    </option>
                  ))}
                  {consumeMissing && (
                    <option value={defaultConsumeLocationId}>Current selection</option>
                  )}
                </select>
                {selectedItem?.defaultLocationId &&
                  defaultConsumeLocationId === selectedItem.defaultLocationId && (
                    <p className="text-xs text-slate-500">Auto from item default location</p>
                  )}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Default produce location</span>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={defaultProduceLocationId}
                  onChange={(e) => setDefaultProduceLocationId(e.target.value)}
                  disabled={mutation.isPending || locationsQuery.isLoading}
                >
                  <option value="">None</option>
                  {locationOptions.map((loc) => (
                    <option key={loc.value} value={loc.value}>
                      {loc.label}
                    </option>
                  ))}
                  {produceMissing && (
                    <option value={defaultProduceLocationId}>Current selection</option>
                  )}
                </select>
                {selectedItem?.defaultLocationId &&
                  defaultProduceLocationId === selectedItem.defaultLocationId && (
                    <p className="text-xs text-slate-500">Auto from item default location</p>
                  )}
              </label>
            </div>
          </Section>

          <Section
            title="Bill of materials"
            description="Select the recipe for this item. If multiple versions exist, choose the one you need."
          >
            {bomsQuery.isLoading && <LoadingSpinner label="Loading BOMs..." />}
            {bomsQuery.isError && bomsQuery.error && (
              <Alert variant="error" title="Failed to load BOMs" message={formatError(bomsQuery.error as ApiError)} />
            )}
            <div className="grid gap-3 md:grid-cols-3">
              <div className="md:col-span-2">
                <Combobox
                  key={outputItemId || 'bom'}
                  label="BOM"
                  value={selectedBomId}
                  options={bomOptions}
                  loading={bomsQuery.isLoading}
                  disabled={mutation.isPending || !outputItemId || bomsQuery.isLoading}
                  placeholder={outputItemId ? 'Search BOM code' : 'Select item first'}
                  emptyMessage={outputItemId ? 'No BOMs found' : 'Select an item first'}
                  onChange={(nextValue) => {
                    setSelectedBomId(nextValue)
                    setSelectedVersionId('')
                    const bom = bomsQuery.data?.boms.find((b) => b.id === nextValue)
                    if (bom) setOutputUom((prev) => prev || bom.defaultUom)
                  }}
                />
              </div>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Version</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={selectedVersionId}
                  onChange={(e) => setSelectedVersionId(e.target.value)}
                  disabled={mutation.isPending || !selectedBom}
                >
                  <option value="">Auto</option>
                  {selectedBom?.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.versionNumber} — {v.status}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedBom && (
              <div className="mt-3 rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-semibold text-slate-800">Components (v{selectedBom.versions.find((v) => v.id === selectedVersionId)?.versionNumber ?? selectedBom.versions[0]?.versionNumber ?? '—'})</div>
                <div className="overflow-hidden rounded border border-slate-200 mt-2">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Line</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Component</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Qty per</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">UOM</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 bg-white">
                      {(selectedBom.versions.find((v) => v.id === selectedVersionId) ??
                        selectedBom.versions[0] ??
                        { components: [] }).components.map((c) => (
                        <tr key={c.id}>
                          <td className="px-3 py-2 text-sm text-slate-800">{c.lineNumber}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{c.componentItemId}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{c.quantityPer}</td>
                          <td className="px-3 py-2 text-sm text-slate-800">{c.uom}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Section>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              Create work order
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
