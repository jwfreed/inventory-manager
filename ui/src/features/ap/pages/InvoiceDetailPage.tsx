import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import {
  getVendorInvoice,
  approveVendorInvoice,
  voidVendorInvoice,
} from '../api/vendorInvoices'
import {
  Button,
  Card,
  Section,
  LoadingSpinner,
  ErrorState,
  Badge,
} from '@shared/ui'
import { formatCurrency, formatDate } from '@shared/formatters'
import type { VendorInvoiceStatus } from '../types'

const statusColors: Record<VendorInvoiceStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  paid: 'bg-blue-100 text-blue-700',
  partially_paid: 'bg-cyan-100 text-cyan-700',
  void: 'bg-red-100 text-red-700',
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  const invoiceQuery = useQuery({
    queryKey: ['vendor-invoice', id],
    queryFn: () => getVendorInvoice(id!),
    enabled: !!id,
  })

  const approveMutation = useMutation({
    mutationFn: () => approveVendorInvoice(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendor-invoice', id] })
      queryClient.invalidateQueries({ queryKey: ['vendor-invoices'] })
    },
  })

  const voidMutation = useMutation({
    mutationFn: () => voidVendorInvoice(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendor-invoice', id] })
      queryClient.invalidateQueries({ queryKey: ['vendor-invoices'] })
    },
  })

  if (invoiceQuery.isLoading) {
    return <LoadingSpinner />
  }

  if (invoiceQuery.error || !invoiceQuery.data) {
    return (
      <ErrorState
        error={{ status: 500, message: String(invoiceQuery.error) }}
        onRetry={() => invoiceQuery.refetch()}
      />
    )
  }

  const invoice = invoiceQuery.data
  const canApprove =
    invoice.status === 'draft' || invoice.status === 'pending_approval'
  const canVoid = invoice.status !== 'void' && invoice.status !== 'paid'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">
              Invoice {invoice.invoiceNumber}
            </h1>
            <Badge className={statusColors[invoice.status]}>
              {invoice.status.replace('_', ' ')}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {invoice.vendorCode} - {invoice.vendorName}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/ap/invoices">
            <Button variant="secondary">Back to List</Button>
          </Link>
          {canApprove && (
            <Button
              variant="primary"
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending}
            >
              Approve
            </Button>
          )}
          {canVoid && (
            <Button
              variant="danger"
              onClick={() => {
                if (
                  window.confirm(
                    'Are you sure you want to void this invoice? This cannot be undone.'
                  )
                ) {
                  voidMutation.mutate()
                }
              }}
              disabled={voidMutation.isPending}
            >
              Void
            </Button>
          )}
        </div>
      </div>

      {/* Invoice Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Invoice Information
            </h2>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Invoice Number:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {invoice.invoiceNumber}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Vendor Invoice #:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {invoice.vendorInvoiceNumber || '-'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">PO Number:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {invoice.poNumber || '-'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Invoice Date:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatDate(invoice.invoiceDate)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Due Date:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatDate(invoice.dueDate)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">GL Date:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {invoice.glDate ? formatDate(invoice.glDate) : '-'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Payment Terms:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {invoice.paymentTermCode || '-'}
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Amount Details
            </h2>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Subtotal:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatCurrency(invoice.subtotal)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Tax:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatCurrency(invoice.taxAmount)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Freight:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatCurrency(invoice.freightAmount)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Discount:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatCurrency(invoice.discountAmount)}
                </dd>
              </div>
              <div className="flex justify-between pt-3 border-t border-slate-200">
                <dt className="text-base font-semibold text-slate-900">
                  Total Amount:
                </dt>
                <dd className="text-base font-bold text-slate-900">
                  {formatCurrency(invoice.totalAmount)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Amount Paid:</dt>
                <dd className="text-sm font-medium text-green-600">
                  {formatCurrency(invoice.amountPaid)}
                </dd>
              </div>
              <div className="flex justify-between pt-3 border-t border-slate-200">
                <dt className="text-base font-semibold text-slate-900">
                  Amount Due:
                </dt>
                <dd className="text-base font-bold text-blue-600">
                  {formatCurrency(invoice.amountDue)}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      </div>

      {/* Line Items */}
      <Section title="Line Items">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Line #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Item
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Description
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Quantity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  UOM
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Unit Price
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Line Amount
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                    {line.lineNumber}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                    {line.itemSku || '-'}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-900">
                    {line.description}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                    {line.quantity}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                    {line.uom}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                    {formatCurrency(line.unitPrice)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                    {formatCurrency(line.lineAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Payment History */}
      {invoice.paymentApplications && invoice.paymentApplications.length > 0 && (
        <Section title="Payment History">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Payment Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Payment #
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Applied Amount
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Discount Taken
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {invoice.paymentApplications.map((app) => (
                  <tr key={app.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {formatDate(app.createdAt)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      Payment #{app.vendorPaymentId.slice(0, 8)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                      {formatCurrency(app.appliedAmount)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                      {formatCurrency(app.discountTaken)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Notes */}
      {invoice.notes && (
        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Notes</h2>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">
              {invoice.notes}
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}
