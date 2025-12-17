/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createWorkOrder, type WorkOrderCreatePayload } from '../../../api/endpoints/workOrders'
import { listBomsByItem } from '../../../api/endpoints/boms'
import { listItems } from '../../../api/endpoints/items'
import type { ApiError, Bom } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea } from '../../../components/Inputs'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'

export default function WorkOrderCreatePage() {
  const navigate = useNavigate()
  const [workOrderNumber, setWorkOrderNumber] = useState('')
  const [outputItemId, setOutputItemId] = useState('')
  const [outputUom, setOutputUom] = useState('')
  const [quantityPlanned, setQuantityPlanned] = useState<number | ''>(0)
  const [scheduledStartAt, setScheduledStartAt] = useState('')
  const [scheduledDueAt, setScheduledDueAt] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedBomId, setSelectedBomId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')

  const itemsQuery = useQuery({
    queryKey: ['items', 'wo-create'],
    queryFn: () => listItems({ limit: 200 }),
    staleTime: 1000 * 60,
  })

  const bomsQuery = useQuery({
    queryKey: ['item-boms', outputItemId],
    queryFn: () => listBomsByItem(outputItemId),
    enabled: !!outputItemId,
  })

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!workOrderNumber || !selectedBomId || !outputItemId || !outputUom || quantityPlanned === '') {
      return
    }
    const toDateTime = (value: string) => (value ? `${value}T00:00:00` : undefined)
    const start = toDateTime(scheduledStartAt)
    const due = toDateTime(scheduledDueAt)

    mutation.mutate({
      workOrderNumber,
      bomId: selectedBomId,
      bomVersionId: selectedVersionId || undefined,
      outputItemId,
      outputUom,
      quantityPlanned: Number(quantityPlanned),
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
            <Alert variant="error" title="Create failed" message={(mutation.error as ApiError).message} />
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
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Quantity planned</span>
                <Input
                  type="number"
                  min={0}
                  value={quantityPlanned}
                  onChange={(e) => setQuantityPlanned(e.target.value === '' ? '' : Number(e.target.value))}
                  required
                  disabled={mutation.isPending}
                />
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
          </Section>

          <Section
            title="Bill of materials"
            description="Select the recipe for this item. If multiple versions exist, choose the one you need."
          >
            {bomsQuery.isLoading && <LoadingSpinner label="Loading BOMs..." />}
            {bomsQuery.isError && bomsQuery.error && (
              <Alert variant="error" title="Failed to load BOMs" message={(bomsQuery.error as ApiError).message} />
            )}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">BOM</span>
                <select
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={selectedBomId}
                  onChange={(e) => {
                    setSelectedBomId(e.target.value)
                    setSelectedVersionId('')
                    const bom = bomsQuery.data?.boms.find((b) => b.id === e.target.value)
                    if (bom) setOutputUom((prev) => prev || bom.defaultUom)
                  }}
                  disabled={mutation.isPending || !outputItemId || bomsQuery.isLoading}
                >
                  <option value="">Select BOM</option>
                  {bomsQuery.data?.boms.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bomCode}
                    </option>
                  ))}
                </select>
              </label>
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
