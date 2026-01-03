import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createVendorInvoice } from '../api/vendorInvoices'
import { useVendorsList } from '../../vendors/queries'
import { Button, Card, Section, ErrorState } from '@shared/ui'
import type { CreateVendorInvoiceInput } from '../types'

export default function InvoiceCreatePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [vendorId, setVendorId] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(
    new Date().toISOString().split('T')[0]
  )
  const [dueDate, setDueDate] = useState('')
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<
    CreateVendorInvoiceInput['lines']
  >([
    {
      lineNumber: 1,
      description: '',
      quantity: 1,
      uom: 'EA',
      unitPrice: 0,
    },
  ])

  const vendorsQuery = useVendorsList(
    { active: true, limit: 500 },
    { staleTime: 60_000 }
  )

  const createMutation = useMutation({
    mutationFn: (data: CreateVendorInvoiceInput) => createVendorInvoice(data),
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ['vendor-invoices'] })
      navigate(`/ap/invoices/${invoice.id}`)
    },
  })

  const handleAddLine = () => {
    setLines([
      ...lines,
      {
        lineNumber: lines.length + 1,
        description: '',
        quantity: 1,
        uom: 'EA',
        unitPrice: 0,
      },
    ])
  }

  const handleRemoveLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index))
  }

  const handleLineChange = (
    index: number,
    field: keyof CreateVendorInvoiceInput['lines'][0],
    value: string | number
  ) => {
    const newLines = [...lines]
    newLines[index] = { ...newLines[index], [field]: value }
    setLines(newLines)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const subtotal = lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice,
      0
    )

    const data: CreateVendorInvoiceInput = {
      vendorId,
      invoiceDate,
      dueDate,
      subtotal,
      taxAmount: 0,
      freightAmount: 0,
      discountAmount: 0,
      vendorInvoiceNumber: vendorInvoiceNumber || undefined,
      notes: notes || undefined,
      lines: lines.map((line, idx) => ({
        ...line,
        lineNumber: idx + 1,
      })),
    }

    createMutation.mutate(data)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Create Vendor Invoice
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Enter invoice details and line items
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/ap/invoices')}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={createMutation.isPending || !vendorId || !dueDate}
          >
            Create Invoice
          </Button>
        </div>
      </div>

      {createMutation.error && (
        <ErrorState
          error={{ status: 500, message: String(createMutation.error) }}
        />
      )}

      {/* Invoice Header */}
      <Card>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Invoice Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Vendor *
              </label>
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="">Select Vendor</option>
                {vendorsQuery.data?.data.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.code} - {vendor.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Invoice Date *
              </label>
              <input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Due Date *
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Vendor Invoice Number
              </label>
              <input
                type="text"
                value={vendorInvoiceNumber}
                onChange={(e) => setVendorInvoiceNumber(e.target.value)}
                placeholder="Vendor's invoice #"
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Line Items */}
      <Section title="Line Items">
        <div className="space-y-4">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid grid-cols-12 gap-4 p-4 bg-slate-50 rounded-md"
            >
              <div className="col-span-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Line #
                </label>
                <input
                  type="number"
                  value={index + 1}
                  readOnly
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded bg-slate-100"
                />
              </div>

              <div className="col-span-4">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Description *
                </label>
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) =>
                    handleLineChange(index, 'description', e.target.value)
                  }
                  required
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Quantity *
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={line.quantity}
                  onChange={(e) =>
                    handleLineChange(index, 'quantity', parseFloat(e.target.value) || 0)
                  }
                  required
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                />
              </div>

              <div className="col-span-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  UOM *
                </label>
                <input
                  type="text"
                  value={line.uom}
                  onChange={(e) => handleLineChange(index, 'uom', e.target.value)}
                  required
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Unit Price *
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={line.unitPrice}
                  onChange={(e) =>
                    handleLineChange(index, 'unitPrice', parseFloat(e.target.value) || 0)
                  }
                  required
                  className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                />
              </div>

              <div className="col-span-2 flex items-end">
                <div className="w-full">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Line Total
                  </label>
                  <input
                    type="text"
                    value={(line.quantity * line.unitPrice).toFixed(2)}
                    readOnly
                    className="w-full px-2 py-1 text-sm border border-slate-300 rounded bg-slate-100"
                  />
                </div>
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveLine(index)}
                    className="ml-2 px-2 py-1 text-sm text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}

          <Button type="button" variant="secondary" onClick={handleAddLine}>
            Add Line Item
          </Button>
        </div>

        <div className="mt-6 pt-6 border-t border-slate-200">
          <div className="flex justify-end">
            <div className="w-64">
              <div className="flex justify-between mb-2">
                <span className="text-sm text-slate-600">Subtotal:</span>
                <span className="text-sm font-medium text-slate-900">
                  $
                  {lines
                    .reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
                    .toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t border-slate-200">
                <span className="text-base font-semibold text-slate-900">
                  Total:
                </span>
                <span className="text-base font-bold text-slate-900">
                  $
                  {lines
                    .reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
                    .toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Section>
    </form>
  )
}
