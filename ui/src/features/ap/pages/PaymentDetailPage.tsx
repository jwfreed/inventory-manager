import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import {
  getVendorPayment,
  postVendorPayment,
  voidVendorPayment,
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
import type { VendorPaymentStatus } from '../types'

const statusColors: Record<VendorPaymentStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  posted: 'bg-green-100 text-green-700',
  cleared: 'bg-blue-100 text-blue-700',
  void: 'bg-red-100 text-red-700',
}

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()

  const paymentQuery = useQuery({
    queryKey: ['vendor-payment', id],
    queryFn: () => getVendorPayment(id!),
    enabled: !!id,
  })

  const postMutation = useMutation({
    mutationFn: () => postVendorPayment(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendor-payment', id] })
      queryClient.invalidateQueries({ queryKey: ['vendor-payments'] })
    },
  })

  const voidMutation = useMutation({
    mutationFn: () => voidVendorPayment(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vendor-payment', id] })
      queryClient.invalidateQueries({ queryKey: ['vendor-payments'] })
    },
  })

  if (paymentQuery.isLoading) {
    return <LoadingSpinner />
  }

  if (paymentQuery.error || !paymentQuery.data) {
    return (
      <ErrorState
        error={{ status: 500, message: String(paymentQuery.error) }}
        onRetry={() => paymentQuery.refetch()}
      />
    )
  }

  const payment = paymentQuery.data
  const canPost = payment.status === 'draft'
  const canVoid = payment.status !== 'void'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">
              Payment {payment.paymentNumber}
            </h1>
            <Badge className={statusColors[payment.status]}>
              {payment.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {payment.vendorCode} - {payment.vendorName}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/ap/payments">
            <Button variant="secondary">Back to List</Button>
          </Link>
          {canPost && (
            <Button
              variant="primary"
              onClick={() => postMutation.mutate()}
              disabled={postMutation.isPending}
            >
              Post Payment
            </Button>
          )}
          {canVoid && (
            <Button
              variant="danger"
              onClick={() => {
                if (
                  window.confirm(
                    'Are you sure you want to void this payment? This cannot be undone.'
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

      {/* Payment Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Payment Information
            </h2>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Payment Number:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {payment.paymentNumber}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Payment Date:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatDate(payment.paymentDate)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Payment Method:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {payment.paymentMethod.replace('_', ' ')}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Reference Number:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {payment.referenceNumber || '-'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Currency:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {payment.currency}
                </dd>
              </div>
              {payment.postedAt && (
                <div className="flex justify-between">
                  <dt className="text-sm text-slate-600">Posted At:</dt>
                  <dd className="text-sm font-medium text-slate-900">
                    {formatDate(payment.postedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </Card>

        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Amount Details
            </h2>
            <dl className="space-y-3">
              <div className="flex justify-between pt-3 border-t border-slate-200">
                <dt className="text-base font-semibold text-slate-900">
                  Payment Amount:
                </dt>
                <dd className="text-base font-bold text-slate-900">
                  {formatCurrency(payment.paymentAmount)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Total Applied:</dt>
                <dd className="text-sm font-medium text-slate-900">
                  {formatCurrency(
                    payment.applications.reduce(
                      (sum, app) => sum + app.appliedAmount,
                      0
                    )
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm text-slate-600">Total Discounts:</dt>
                <dd className="text-sm font-medium text-green-600">
                  {formatCurrency(
                    payment.applications.reduce(
                      (sum, app) => sum + app.discountTaken,
                      0
                    )
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      </div>

      {/* Invoice Applications */}
      <Section title="Invoice Applications">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Invoice #
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Due Date
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Invoice Amount
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Applied Amount
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Discount Taken
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {payment.applications.map((app) => (
                <tr key={app.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
                    <Link to={`/ap/invoices/${app.vendorInvoiceId}`}>
                      {app.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                    {formatDate(app.invoiceDueDate)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                    {formatCurrency(app.invoiceTotalAmount)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 text-right">
                    {formatCurrency(app.appliedAmount)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600 text-right">
                    {formatCurrency(app.discountTaken)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                    <Link
                      to={`/ap/invoices/${app.vendorInvoiceId}`}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      View Invoice
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Notes */}
      {payment.notes && (
        <Card>
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Notes</h2>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">
              {payment.notes}
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}
