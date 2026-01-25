import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createSalesOrder, type SalesOrderPayload } from '../api/salesOrders'
import type { ApiError } from '../../../api/types'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { Input, Textarea, Select } from '../../../components/Inputs'
import { Section } from '../../../components/Section'

const statusOptions: SalesOrderPayload['status'][] = [
  'draft',
  'submitted',
  'partially_shipped',
  'shipped',
  'closed',
  'canceled',
]

type LineDraft = {
  lineNumber?: number
  itemId: string
  uom: string
  quantityOrdered: number | ''
  notes?: string
}

export default function SalesOrderCreatePage() {
  const navigate = useNavigate()
  const [soNumber, setSoNumber] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState<SalesOrderPayload['status']>('draft')
  const [orderDate, setOrderDate] = useState('')
  const [requestedShipDate, setRequestedShipDate] = useState('')
  const [shipFromLocationId, setShipFromLocationId] = useState('')
  const [customerReference, setCustomerReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([
    { lineNumber: 1, itemId: '', uom: '', quantityOrdered: '' },
  ])
  const [warning, setWarning] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (payload: SalesOrderPayload) => createSalesOrder(payload),
    onSuccess: (order) => {
      navigate(`/sales-orders/${order.id}`)
    },
  })

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      { lineNumber: prev.length + 1, itemId: '', uom: '', quantityOrdered: '' },
    ])

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index).map((line, idx) => ({ ...line, lineNumber: idx + 1 })))
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const validLines = lines.filter(
      (line) => line.itemId && line.uom && line.quantityOrdered !== '' && Number(line.quantityOrdered) > 0,
    )
    if (!soNumber || !customerId) {
      setWarning('SO number and customer are required.')
      return
    }
    if (validLines.length === 0) {
      setWarning('Add at least one line with item, uom, and quantity > 0.')
      return
    }
    setWarning(null)
    mutation.mutate({
      soNumber,
      customerId,
      status: status || undefined,
      orderDate: orderDate || undefined,
      requestedShipDate: requestedShipDate || undefined,
      shipFromLocationId: shipFromLocationId || undefined,
      customerReference: customerReference || undefined,
      notes: notes || undefined,
      lines: validLines.map((line, idx) => ({
        lineNumber: line.lineNumber ?? idx + 1,
        itemId: line.itemId,
        uom: line.uom,
        quantityOrdered: Number(line.quantityOrdered),
        notes: line.notes || undefined,
      })),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Create sales order</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/sales-orders')}>
          Back to list
        </Button>
      </div>

      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          {mutation.isError && (
            <Alert variant="error" title="Create failed" message={(mutation.error as ApiError).message} />
          )}
          {warning && <Alert variant="warning" title="Check required fields" message={warning} />}
          <Section title="Header">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">SO Number</span>
                <Input
                  value={soNumber}
                  onChange={(e) => setSoNumber(e.target.value)}
                  required
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Customer ID</span>
                <Input
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as SalesOrderPayload['status'])}
                  disabled={mutation.isPending}
                >
                  {statusOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Order date</span>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Requested ship date</span>
                <Input
                  type="date"
                  value={requestedShipDate}
                  onChange={(e) => setRequestedShipDate(e.target.value)}
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-slate-500">Ship-from location ID</span>
                <Input
                  value={shipFromLocationId}
                  onChange={(e) => setShipFromLocationId(e.target.value)}
                  placeholder="Optional"
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Customer reference</span>
                <Input
                  value={customerReference}
                  onChange={(e) => setCustomerReference(e.target.value)}
                  placeholder="Optional"
                  disabled={mutation.isPending}
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-3">
                <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional"
                  disabled={mutation.isPending}
                />
              </label>
            </div>
          </Section>

          <Section title="Lines">
            <div className="flex items-center justify-between">
              <div className="text-sm text-slate-700">Add at least one line with quantity &gt; 0.</div>
              <Button variant="secondary" size="sm" type="button" onClick={addLine} disabled={mutation.isPending}>
                Add line
              </Button>
            </div>
            <div className="space-y-3">
              {lines.map((line, idx) => (
                <div key={idx} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-5">
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Line #</span>
                    <Input
                      type="number"
                      min={1}
                      value={line.lineNumber ?? idx + 1}
                      onChange={(e) =>
                        updateLine(idx, { lineNumber: e.target.value ? Number(e.target.value) : undefined })
                      }
                      disabled={mutation.isPending}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Item ID</span>
                    <Input
                      value={line.itemId}
                      onChange={(e) => updateLine(idx, { itemId: e.target.value })}
                      required
                      disabled={mutation.isPending}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">UOM</span>
                    <Input
                      value={line.uom}
                      onChange={(e) => updateLine(idx, { uom: e.target.value })}
                      required
                      disabled={mutation.isPending}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Quantity</span>
                    <Input
                      type="number"
                      min={0}
                      value={line.quantityOrdered}
                      onChange={(e) =>
                        updateLine(idx, {
                          quantityOrdered: e.target.value === '' ? '' : Number(e.target.value),
                        })
                      }
                      required
                      disabled={mutation.isPending}
                    />
                  </label>
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="text-xs uppercase tracking-wide text-slate-500">Notes</span>
                    <Textarea
                      value={line.notes || ''}
                      onChange={(e) => updateLine(idx, { notes: e.target.value })}
                      disabled={mutation.isPending}
                    />
                  </label>
                  {lines.length > 1 && (
                    <div className="flex items-center justify-end md:col-span-5">
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={mutation.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={mutation.isPending || lines.length === 0}>
              Create sales order
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
