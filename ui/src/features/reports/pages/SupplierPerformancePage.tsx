import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { 
  getLeadTimeReliability, 
  getPriceVarianceTrends, 
  getVendorFillRate, 
  getVendorQualityRate 
} from '../api/reports'
import { useVendorsList } from '../../vendors/queries'
import { Card, Section, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { Vendor } from '../../../api/types/vendors'
import type { ApiError } from '../../../api/types/common'

const getDefaultStartDate = () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const getDefaultEndDate = () => new Date().toISOString().slice(0, 10)

export default function SupplierPerformancePage() {
  const [vendorFilter, setVendorFilter] = useState('')
  const [startDate, setStartDate] = useState(getDefaultStartDate())
  const [endDate, setEndDate] = useState(getDefaultEndDate())

  const leadTimeQuery = useQuery({
    queryKey: ['lead-time-reliability', vendorFilter, startDate, endDate],
    queryFn: () => getLeadTimeReliability({
      startDate,
      endDate,
      vendorId: vendorFilter || undefined,
      limit: 50,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const priceVarianceQuery = useQuery({
    queryKey: ['price-variance-trends', vendorFilter, startDate, endDate],
    queryFn: () => getPriceVarianceTrends({
      startDate,
      endDate,
      vendorId: vendorFilter || undefined,
      limit: 200,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const fillRateQuery = useQuery({
    queryKey: ['vendor-fill-rate', vendorFilter, startDate, endDate],
    queryFn: () => getVendorFillRate({
      startDate,
      endDate,
      vendorId: vendorFilter || undefined,
      limit: 50,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const qualityQuery = useQuery({
    queryKey: ['vendor-quality-rate', vendorFilter, startDate, endDate],
    queryFn: () => getVendorQualityRate({
      startDate,
      endDate,
      vendorId: vendorFilter || undefined,
      limit: 50,
    }),
    staleTime: 60_000,
    enabled: Boolean(startDate && endDate),
  })

  const vendorsQuery = useVendorsList({ limit: 200 }, { staleTime: 60_000 })

  // Calculate summary metrics
  const avgReliability = (leadTimeQuery.data?.data.reduce((sum, v) => sum + Number(v.reliabilityPercent), 0) || 0) / (leadTimeQuery.data?.data.length || 1)
  const avgFillRate = (fillRateQuery.data?.data.reduce((sum, v) => sum + Number(v.fillRatePercent), 0) || 0) / (fillRateQuery.data?.data.length || 1)
  const avgQualityRate = (qualityQuery.data?.data.reduce((sum, v) => sum + Number(v.qualityRatePercent), 0) || 0) / (qualityQuery.data?.data.length || 1)
  const totalReceipts = leadTimeQuery.data?.data.reduce((sum, v) => sum + Number(v.totalReceipts), 0) || 0

  // Prepare chart data - group price variance by vendor for line chart
  const priceVarianceChartData = priceVarianceQuery.data?.data.reduce((acc, row) => {
    const month = row.month
    const existing = acc.find(item => item.month === month)
    if (existing) {
      existing[row.vendorCode] = Number(row.variancePercent)
    } else {
      acc.push({ month, [row.vendorCode]: Number(row.variancePercent) })
    }
    return acc
  }, [] as Array<Record<string, number | string>>) || []

  // Get unique vendor codes for price variance chart
  const vendorCodes = Array.from(new Set(priceVarianceQuery.data?.data.map(d => d.vendorCode) || []))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Supplier Performance Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Track vendor reliability, pricing, fill rates, and quality metrics
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Avg Delivery Reliability</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(avgReliability)}%</div>
            {leadTimeQuery.data && (
              <div className="mt-1 text-xs text-slate-500">{totalReceipts} receipts</div>
            )}
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Avg Fill Rate</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(avgFillRate)}%</div>
            {fillRateQuery.data && (
              <div className="mt-1 text-xs text-slate-500">
                {fillRateQuery.data.data.reduce((sum, v) => sum + Number(v.totalPOs), 0)} POs
              </div>
            )}
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Avg Quality Rate</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">{formatNumber(avgQualityRate)}%</div>
            <div className="mt-1 text-xs text-slate-500">Placeholder metric</div>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-600 font-medium">Active Vendors</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {leadTimeQuery.data?.data.length || 0}
            </div>
          </div>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vendor</label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">All Vendors</option>
                {vendorsQuery.data?.data.map((vendor: Vendor) => (
                  <option key={vendor.id} value={vendor.id}>{vendor.code} - {vendor.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Price Variance Trends Chart */}
      <Section title="Price Variance Trends">
        {priceVarianceQuery.isLoading && <LoadingSpinner />}
        {priceVarianceQuery.isError && <ErrorState error={priceVarianceQuery.error as unknown as ApiError} />}
        
        {priceVarianceQuery.data && priceVarianceChartData.length > 0 && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceVarianceChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis label={{ value: 'Variance %', angle: -90, position: 'insideLeft' }} />
                <Tooltip />
                <Legend />
                {vendorCodes.slice(0, 5).map((code, idx) => (
                  <Line 
                    key={code} 
                    type="monotone" 
                    dataKey={code} 
                    stroke={`hsl(${idx * 70}, 70%, 50%)`}
                    strokeWidth={2}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {priceVarianceQuery.data && priceVarianceChartData.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            No price variance data available
          </div>
        )}
      </Section>

      {/* Lead Time Reliability */}
      <Section title="Lead Time Reliability">
        {leadTimeQuery.isLoading && <LoadingSpinner />}
        {leadTimeQuery.isError && <ErrorState error={leadTimeQuery.error as unknown as ApiError} />}
        
        {leadTimeQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Vendor</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Receipts</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">On Time</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Late</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Avg Lead Time</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Promised</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Reliability</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {leadTimeQuery.data.data.map((row) => (
                  <tr key={row.vendorId}>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium">{row.vendorCode}</div>
                      <div className="text-xs text-slate-500">{row.vendorName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.totalReceipts)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-emerald-600">{formatNumber(row.onTimeReceipts)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-rose-600">{formatNumber(row.lateReceipts)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.avgLeadTimeDays)} days</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.avgPromisedLeadTimeDays)} days</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <Badge 
                        variant={Number(row.reliabilityPercent) >= 95 ? 'success' : Number(row.reliabilityPercent) >= 80 ? 'warning' : 'danger'}
                      >
                        {formatNumber(row.reliabilityPercent)}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {leadTimeQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No lead time data available
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Vendor Fill Rate */}
      <Section title="Vendor Fill Rate">
        {fillRateQuery.isLoading && <LoadingSpinner />}
        {fillRateQuery.isError && <ErrorState error={fillRateQuery.error as unknown as ApiError} />}
        
        {fillRateQuery.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-600 uppercase">Vendor</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Total POs</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Fully Received</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Ordered</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Received</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-600 uppercase">Fill Rate</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {fillRateQuery.data.data.map((row) => (
                  <tr key={row.vendorId}>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium">{row.vendorCode}</div>
                      <div className="text-xs text-slate-500">{row.vendorName}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.totalPOs)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-emerald-600">{formatNumber(row.fullyReceivedPOs)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.totalOrdered)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{formatNumber(row.totalReceived)}</td>
                    <td className="px-4 py-3 text-sm text-right">
                      <Badge 
                        variant={Number(row.fillRatePercent) >= 95 ? 'success' : Number(row.fillRatePercent) >= 80 ? 'warning' : 'danger'}
                      >
                        {formatNumber(row.fillRatePercent)}%
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {fillRateQuery.data.data.length === 0 && (
              <div className="text-center py-12 text-slate-500">
                No fill rate data available
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
