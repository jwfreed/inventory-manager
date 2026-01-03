import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listVendorPayments } from '../api/vendorInvoices'
import { useVendorsList } from '../../vendors/queries'
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

export default function PaymentListPage() {
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [vendorFilter, setVendorFilter] = useState<string>('')

  const paymentsQuery = useQuery({
    queryKey: ['vendor-payments', statusFilter, vendorFilter],
    queryFn: () =>
      listVendorPayments({
        status: statusFilter || undefined,
        vendorId: vendorFilter || undefined,
        limit: 500,
      }),
    staleTime: 30_000,
  })

  const vendorsQuery = useVendorsList(
    { active: true, limit: 500 },
    { staleTime: 60_000 }
  )

  if (paymentsQuery.isLoading) {
    return <LoadingSpinner />
  }

  if (paymentsQuery.error) {
    return (
      <ErrorState
        error={{ status: 500, message: String(paymentsQuery.error) }}
        onRetry={() => paymentsQuery.refetch()}
      />
    )
  }

  const payments = paymentsQuery.data?.data || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Vendor Payments</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage vendor payments and disbursements
          </p>
        </div>
        <Link to="/ap/payments/create">
          <Button variant="primary">Create Payment</Button>
        </Link>
      </div>

      {/* Filters */}
      <Card>
        <div className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cleared">Cleared</option>
                <option value="void">Void</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Vendor
              </label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="">All Vendors</option>
                {vendorsQuery.data?.data.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.code} - {vendor.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* Payment List */}
      <Section>
        {payments.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No payments found</p>
            <Link to="/ap/payments/create">
              <Button variant="primary" className="mt-4">
                Create First Payment
              </Button>
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Payment #
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Vendor
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Payment Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Method
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Reference #
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Invoices
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
                      <Link to={`/ap/payments/${payment.id}`}>
                        {payment.paymentNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {payment.vendorCode} - {payment.vendorName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {formatDate(payment.paymentDate)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {payment.paymentMethod.replace('_', ' ')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {payment.referenceNumber || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {formatCurrency(payment.paymentAmount)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {payment.invoiceCount || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge className={statusColors[payment.status]}>
                        {payment.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      <Link
                        to={`/ap/payments/${payment.id}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}
