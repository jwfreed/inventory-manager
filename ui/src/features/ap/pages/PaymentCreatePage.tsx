import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  createVendorPayment,
  getUnpaidInvoicesForVendor,
} from '../api/vendorInvoices'
import { useVendorsList } from '../../vendors/queries'
import { Button, Card, Section, ErrorState, LoadingSpinner } from '@shared/ui'
import { formatCurrency, formatDate } from '@shared/formatters'
import type { CreateVendorPaymentInput, VendorPaymentMethod } from '../types'

export default function PaymentCreatePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [vendorId, setVendorId] = useState('')
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().split('T')[0]
  )
  const [paymentMethod, setPaymentMethod] =
    useState<VendorPaymentMethod>('check')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedInvoices, setSelectedInvoices] = useState<
    Map<string, { appliedAmount: number; discountTaken: number }>
  >(new Map())

  const vendorsQuery = useVendorsList(
    { active: true, limit: 500 },
    { staleTime: 60_000 }
  )

  const unpaidInvoicesQuery = useQuery({
    queryKey: ['unpaid-invoices', vendorId],
    queryFn: () => getUnpaidInvoicesForVendor(vendorId),
    enabled: !!vendorId,
    staleTime: 30_000,
  })

  const createMutation = useMutation({
    mutationFn: (data: CreateVendorPaymentInput) => createVendorPayment(data),
    onSuccess: (payment) => {
      queryClient.invalidateQueries({ queryKey: ['vendor-payments'] })
      queryClient.invalidateQueries({ queryKey: ['vendor-invoices'] })
      navigate(`/ap/payments/${payment.id}`)
    },
  })

  const totalPaymentAmount = Array.from(selectedInvoices.values()).reduce(
    (sum, app) => sum + app.appliedAmount + app.discountTaken,
    0
  )

  const handleToggleInvoice = (invoiceId: string, amountDue: number) => {
    const newSelected = new Map(selectedInvoices)
    if (newSelected.has(invoiceId)) {
      newSelected.delete(invoiceId)
    } else {
      newSelected.set(invoiceId, { appliedAmount: amountDue, discountTaken: 0 })
    }
    setSelectedInvoices(newSelected)
  }

  const handleUpdateApplication = (
    invoiceId: string,
    field: 'appliedAmount' | 'discountTaken',
    value: number
  ) => {
    const newSelected = new Map(selectedInvoices)
    const current = newSelected.get(invoiceId)
    if (current) {
      newSelected.set(invoiceId, { ...current, [field]: value })
      setSelectedInvoices(newSelected)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (selectedInvoices.size === 0) {
      alert('Please select at least one invoice to pay')
      return
    }

    const data: CreateVendorPaymentInput = {
      vendorId,
      paymentDate,
      paymentMethod,
      referenceNumber: referenceNumber || undefined,
      paymentAmount: totalPaymentAmount,
      notes: notes || undefined,
      applications: Array.from(selectedInvoices.entries()).map(
        ([invoiceId, app]) => ({
          vendorInvoiceId: invoiceId,
          appliedAmount: app.appliedAmount,
          discountTaken: app.discountTaken,
        })
      ),
    }

    createMutation.mutate(data)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Create Vendor Payment
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Select invoices to pay and enter payment details
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/ap/payments')}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={
              createMutation.isPending ||
              !vendorId ||
              selectedInvoices.size === 0
            }
          >
            Create Payment
          </Button>
        </div>
      </div>

      {createMutation.error && (
        <ErrorState
          error={{ status: 500, message: String(createMutation.error) }}
        />
      )}

      {/* Payment Header */}
      <Card>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Payment Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Vendor *
              </label>
              <select
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value)
                  setSelectedInvoices(new Map())
                }}
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
                Payment Date *
              </label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Payment Method *
              </label>
              <select
                value={paymentMethod}
                onChange={(e) =>
                  setPaymentMethod(e.target.value as VendorPaymentMethod)
                }
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="check">Check</option>
                <option value="ach">ACH</option>
                <option value="wire">Wire Transfer</option>
                <option value="credit_card">Credit Card</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Reference Number
              </label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Check #, Confirmation #, etc."
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

      {/* Invoice Selection */}
      {vendorId && (
        <Section title="Select Invoices to Pay">
          {unpaidInvoicesQuery.isLoading ? (
            <LoadingSpinner />
          ) : unpaidInvoicesQuery.error ? (
            <ErrorState
              error={{ status: 500, message: String(unpaidInvoicesQuery.error) }}
            />
          ) : unpaidInvoicesQuery.data?.data.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-slate-500">
                No unpaid invoices found for this vendor
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      <input
                        type="checkbox"
                        onChange={(e) => {
                          if (e.target.checked) {
                            const newSelected = new Map()
                            unpaidInvoicesQuery.data?.data.forEach((inv) => {
                              newSelected.set(inv.id, {
                                appliedAmount: inv.amountDue,
                                discountTaken: 0,
                              })
                            })
                            setSelectedInvoices(newSelected)
                          } else {
                            setSelectedInvoices(new Map())
                          }
                        }}
                        checked={
                          selectedInvoices.size ===
                          (unpaidInvoicesQuery.data?.data.length || 0)
                        }
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Invoice #
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Invoice Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Due Date
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Total Amount
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Amount Due
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Applied Amount
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                      Discount
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-200">
                  {unpaidInvoicesQuery.data?.data.map((invoice) => {
                    const isSelected = selectedInvoices.has(invoice.id)
                    const application = selectedInvoices.get(invoice.id)

                    return (
                      <tr key={invoice.id} className="hover:bg-slate-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() =>
                              handleToggleInvoice(invoice.id, invoice.amountDue)
                            }
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                          {invoice.invoiceNumber}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                          {formatDate(invoice.invoiceDate)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                          {formatDate(invoice.dueDate)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                          {formatCurrency(invoice.totalAmount)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                          {formatCurrency(invoice.amountDue)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isSelected ? (
                            <input
                              type="number"
                              step="0.01"
                              value={application?.appliedAmount || 0}
                              onChange={(e) =>
                                handleUpdateApplication(
                                  invoice.id,
                                  'appliedAmount',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="w-24 px-2 py-1 text-sm text-right border border-slate-300 rounded"
                            />
                          ) : (
                            <span className="text-sm text-slate-400">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isSelected ? (
                            <input
                              type="number"
                              step="0.01"
                              value={application?.discountTaken || 0}
                              onChange={(e) =>
                                handleUpdateApplication(
                                  invoice.id,
                                  'discountTaken',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              className="w-24 px-2 py-1 text-sm text-right border border-slate-300 rounded"
                            />
                          ) : (
                            <span className="text-sm text-slate-400">-</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* Payment Summary */}
      {selectedInvoices.size > 0 && (
        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Payment Summary
            </h2>
            <div className="flex justify-end">
              <div className="w-64">
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-slate-600">
                    Invoices Selected:
                  </span>
                  <span className="text-sm font-medium text-slate-900">
                    {selectedInvoices.size}
                  </span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-slate-600">
                    Total Applied:
                  </span>
                  <span className="text-sm font-medium text-slate-900">
                    {formatCurrency(
                      Array.from(selectedInvoices.values()).reduce(
                        (sum, app) => sum + app.appliedAmount,
                        0
                      )
                    )}
                  </span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-slate-600">
                    Total Discounts:
                  </span>
                  <span className="text-sm font-medium text-green-600">
                    {formatCurrency(
                      Array.from(selectedInvoices.values()).reduce(
                        (sum, app) => sum + app.discountTaken,
                        0
                      )
                    )}
                  </span>
                </div>
                <div className="flex justify-between pt-3 border-t border-slate-200">
                  <span className="text-base font-semibold text-slate-900">
                    Payment Amount:
                  </span>
                  <span className="text-base font-bold text-slate-900">
                    {formatCurrency(totalPaymentAmount)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
    </form>
  )
}
