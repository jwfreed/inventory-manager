import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listVendorInvoices, getApDashboardMetrics } from '../api/vendorInvoices'
import { Button, Card, LoadingSpinner, ErrorState } from '@shared/ui'
import { formatCurrency, formatDate } from '@shared/formatters'

export default function ApDashboardPage() {
  const metricsQuery = useQuery({
    queryKey: ['ap-dashboard-metrics'],
    queryFn: getApDashboardMetrics,
    staleTime: 60_000,
  })

  const recentInvoicesQuery = useQuery({
    queryKey: ['vendor-invoices', 'recent'],
    queryFn: () => listVendorInvoices({ limit: 10 }),
    staleTime: 30_000,
  })

  const upcomingPaymentsQuery = useQuery({
    queryKey: ['vendor-invoices', 'upcoming'],
    queryFn: () =>
      listVendorInvoices({
        status: 'approved',
        limit: 10,
      }),
    staleTime: 30_000,
  })

  if (metricsQuery.isLoading) {
    return <LoadingSpinner />
  }

  if (metricsQuery.error) {
    return (
      <ErrorState
        error={{ status: 500, message: String(metricsQuery.error) }}
        onRetry={() => metricsQuery.refetch()}
      />
    )
  }

  const metrics = metricsQuery.data

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Accounts Payable Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Overview of outstanding payables and recent activity
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/ap/invoices/create">
            <Button variant="secondary">New Invoice</Button>
          </Link>
          <Link to="/ap/payments/create">
            <Button variant="primary">New Payment</Button>
          </Link>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">
              Total Outstanding
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatCurrency(metrics?.totalOutstanding || 0)}
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">
              Current Due
            </div>
            <div className="mt-2 text-2xl font-bold text-green-600">
              {formatCurrency(metrics?.currentDue || 0)}
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">
              Past Due
            </div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatCurrency(metrics?.pastDue || 0)}
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">
              Due in 7 Days
            </div>
            <div className="mt-2 text-2xl font-bold text-yellow-600">
              {metrics?.invoicesDue7Days || 0}
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">
              Due in 30 Days
            </div>
            <div className="mt-2 text-2xl font-bold text-blue-600">
              {metrics?.invoicesDue30Days || 0}
            </div>
          </div>
        </Card>
      </div>

      {/* Aging Chart */}
      <Card>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Aging Summary
          </h2>
          <div className="space-y-4">
            {metrics?.agingBuckets.map((bucket) => (
              <div key={bucket.period}>
                <div className="flex justify-between mb-1">
                  <span className="text-sm text-slate-600">
                    {bucket.period === 'current'
                      ? 'Current'
                      : bucket.period === '1-30'
                        ? '1-30 Days'
                        : bucket.period === '31-60'
                          ? '31-60 Days'
                          : bucket.period === '61-90'
                            ? '61-90 Days'
                            : 'Over 90 Days'}
                  </span>
                  <span className="text-sm font-medium text-slate-900">
                    {bucket.count} invoices - {formatCurrency(bucket.amount)}
                  </span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      bucket.period === 'current'
                        ? 'bg-green-500'
                        : bucket.period === '1-30'
                          ? 'bg-blue-500'
                          : bucket.period === '31-60'
                            ? 'bg-yellow-500'
                            : bucket.period === '61-90'
                              ? 'bg-orange-500'
                              : 'bg-red-500'
                    }`}
                    style={{
                      width: `${metrics.totalOutstanding > 0 ? (bucket.amount / metrics.totalOutstanding) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Invoices */}
        <Card>
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">
                Recent Invoices
              </h2>
              <Link
                to="/ap/invoices"
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                View All
              </Link>
            </div>
            {recentInvoicesQuery.isLoading ? (
              <LoadingSpinner />
            ) : recentInvoicesQuery.data?.data.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">
                No invoices yet
              </p>
            ) : (
              <div className="space-y-3">
                {recentInvoicesQuery.data?.data.map((invoice) => (
                  <Link
                    key={invoice.id}
                    to={`/ap/invoices/${invoice.id}`}
                    className="block p-3 bg-slate-50 rounded-md hover:bg-slate-100"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="text-sm font-medium text-slate-900">
                          {invoice.invoiceNumber}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {invoice.vendorName}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-slate-900">
                          {formatCurrency(invoice.totalAmount)}
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {formatDate(invoice.invoiceDate)}
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Upcoming Payments */}
        <Card>
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-900">
                Upcoming Payments
              </h2>
              <Link
                to="/ap/payments"
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                View All
              </Link>
            </div>
            {upcomingPaymentsQuery.isLoading ? (
              <LoadingSpinner />
            ) : upcomingPaymentsQuery.data?.data.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">
                No approved invoices
              </p>
            ) : (
              <div className="space-y-3">
                {upcomingPaymentsQuery.data?.data.map((invoice) => {
                  const daysUntilDue = Math.ceil(
                    (new Date(invoice.dueDate).getTime() - new Date().getTime()) /
                      (1000 * 60 * 60 * 24)
                  )
                  const isOverdue = daysUntilDue < 0
                  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7

                  return (
                    <Link
                      key={invoice.id}
                      to={`/ap/invoices/${invoice.id}`}
                      className="block p-3 bg-slate-50 rounded-md hover:bg-slate-100"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="text-sm font-medium text-slate-900">
                            {invoice.invoiceNumber}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {invoice.vendorName}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium text-slate-900">
                            {formatCurrency(invoice.amountDue)}
                          </div>
                          <div
                            className={`text-xs mt-1 ${
                              isOverdue
                                ? 'text-red-600 font-medium'
                                : isDueSoon
                                  ? 'text-yellow-600'
                                  : 'text-slate-500'
                            }`}
                          >
                            {isOverdue
                              ? `${Math.abs(daysUntilDue)} days overdue`
                              : `Due in ${daysUntilDue} days`}
                          </div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Quick Actions
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Link to="/ap/invoices/create">
              <Button variant="secondary" className="w-full">
                Create Invoice
              </Button>
            </Link>
            <Link to="/ap/payments/create">
              <Button variant="primary" className="w-full">
                Make Payment
              </Button>
            </Link>
            <Link to="/ap/invoices?status=pending_approval">
              <Button variant="secondary" className="w-full">
                Review Pending
              </Button>
            </Link>
            <Link to="/ap/invoices?status=approved">
              <Button variant="secondary" className="w-full">
                View Approved
              </Button>
            </Link>
          </div>
        </div>
      </Card>
    </div>
  )
}
