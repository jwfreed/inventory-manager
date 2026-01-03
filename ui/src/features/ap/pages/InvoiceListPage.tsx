import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listVendorInvoices } from '../api/vendorInvoices'
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
import type { VendorInvoiceStatus } from '../types'

const statusColors: Record<VendorInvoiceStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  paid: 'bg-blue-100 text-blue-700',
  partially_paid: 'bg-cyan-100 text-cyan-700',
  void: 'bg-red-100 text-red-700',
}

export default function InvoiceListPage() {
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [vendorFilter, setVendorFilter] = useState<string>('')

  const invoicesQuery = useQuery({
    queryKey: ['vendor-invoices', statusFilter, vendorFilter],
    queryFn: () =>
      listVendorInvoices({
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

  if (invoicesQuery.isLoading) {
    return <LoadingSpinner />
  }

  if (invoicesQuery.error) {
    return (
      <ErrorState
        error={{ status: 500, message: String(invoicesQuery.error) }}
        onRetry={() => invoicesQuery.refetch()}
      />
    )
  }

  const invoices = invoicesQuery.data?.data || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Vendor Invoices</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage vendor invoices and approvals
          </p>
        </div>
        <Link to="/ap/invoices/create">
          <Button variant="primary">Create Invoice</Button>
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
                <option value="pending_approval">Pending Approval</option>
                <option value="approved">Approved</option>
                <option value="partially_paid">Partially Paid</option>
                <option value="paid">Paid</option>
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

      {/* Invoice List */}
      <Section>
        {invoices.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No invoices found</p>
            <Link to="/ap/invoices/create">
              <Button variant="primary" className="mt-4">
                Create First Invoice
              </Button>
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Invoice #
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Vendor
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    PO #
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Invoice Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Due Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Total Amount
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Amount Due
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
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
                      <Link to={`/ap/invoices/${invoice.id}`}>
                        {invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {invoice.vendorCode} - {invoice.vendorName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {invoice.poNumber || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {formatDate(invoice.invoiceDate)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      {formatDate(invoice.dueDate)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {formatCurrency(invoice.totalAmount)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                      {formatCurrency(invoice.amountDue)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge className={statusColors[invoice.status]}>
                        {invoice.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                      <Link
                        to={`/ap/invoices/${invoice.id}`}
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
