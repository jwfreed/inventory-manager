import { useMemo, useState, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useProductionOverview } from '../productionOverviewQueries'
import { useItemsList } from '@features/items/queries'
import { useLocationsList } from '@features/locations/queries'
import { Button, Card, LoadingSpinner, ErrorState, Badge } from '@shared/ui'
import { formatNumber } from '@shared/formatters'
import { SimpleLineChart, SimpleBarChart } from '@shared/charts'
import { ChartExportButton } from '@shared/charts/ChartExportButton'
import type { ProductionOverviewFilters } from '../api/productionOverview'
import { usePageChrome } from '../../../app/layout/usePageChrome'

export default function ProductionOverviewPage() {
  const navigate = useNavigate()
  const { hideTitle } = usePageChrome()
  const volumeTrendChartRef = useRef<HTMLDivElement>(null)
  const topSKUsChartRef = useRef<HTMLDivElement>(null)
  const wipStatusChartRef = useRef<HTMLDivElement>(null)
  const materialsChartRef = useRef<HTMLDivElement>(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [itemId, setItemId] = useState('')
  const [locationId, setLocationId] = useState('')

  const filters = useMemo(() => {
    const f: ProductionOverviewFilters = {}
    if (dateFrom) f.dateFrom = `${dateFrom}T00:00:00Z`
    if (dateTo) f.dateTo = `${dateTo}T23:59:59.999Z`
    if (itemId) f.itemId = itemId
    if (locationId) f.locationId = locationId
    return f
  }, [dateFrom, dateTo, itemId, locationId])

  const overviewQuery = useProductionOverview(filters, { staleTime: 30_000 })
  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })
  const locationsQuery = useLocationsList({ active: true, limit: 200 }, { staleTime: 60_000 })

  const items = useMemo(() => itemsQuery.data?.data ?? [], [itemsQuery.data])
  const locations = useMemo(() => locationsQuery.data?.data ?? [], [locationsQuery.data])

  const itemsMap = useMemo(() => {
    return new Map(items.map((item) => [item.id, item]))
  }, [items])

  const handleExportVolumeTrend = () => {
    if (!overviewQuery.data?.volumeTrend) return

    const headers = ['Date', 'Work Orders Completed', 'Total Quantity']
    const rows = overviewQuery.data.volumeTrend.map((row) => [
      new Date(row.period).toLocaleDateString(),
      row.workOrderCount,
      row.totalQuantity,
    ])

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
    downloadCSV(csv, 'production-volume-trend')
  }

  const handleExportTopBottomSKUs = () => {
    if (!overviewQuery.data?.topBottomSKUs) return

    const headers = ['SKU', 'Item Name', 'Production Frequency', 'Avg Batch Size', 'Total Produced', 'UOM']
    const rows = overviewQuery.data.topBottomSKUs.map((row) => {
      const item = itemsMap.get(row.itemId)
      return [
        item?.sku || row.itemId,
        item?.name || 'Unknown',
        row.productionFrequency,
        row.avgBatchSize,
        row.totalProduced,
        row.uom,
      ]
    })

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
    downloadCSV(csv, 'top-bottom-skus')
  }

  const handleExportWIPStatus = () => {
    if (!overviewQuery.data?.wipStatus) return

    const headers = ['Status', 'Work Order Count', 'Total Planned', 'Total Completed']
    const rows = overviewQuery.data.wipStatus.map((row) => [
      row.status,
      row.workOrderCount,
      row.totalPlanned,
      row.totalCompleted,
    ])

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
    downloadCSV(csv, 'wip-status')
  }

  const handleExportMaterialsConsumed = () => {
    if (!overviewQuery.data?.materialsConsumed) return

    const headers = ['SKU', 'Item Name', 'UOM', 'Total Consumed', 'Work Orders', 'Executions']
    const rows = overviewQuery.data.materialsConsumed.map((row) => {
      const item = itemsMap.get(row.itemId)
      return [
        item?.sku || row.itemId,
        item?.name || 'Unknown',
        row.uom,
        row.totalConsumed,
        row.workOrderCount,
        row.executionCount,
      ]
    })

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
    downloadCSV(csv, 'materials-consumed')
  }

  const handleExportAll = () => {
    if (!overviewQuery.data) return

    // Combine all sections into one CSV
    let csv = '=== PRODUCTION VOLUME TREND ===\n'
    csv += 'Date,Work Orders Completed,Total Quantity\n'
    overviewQuery.data.volumeTrend.forEach((row) => {
      csv += `${new Date(row.period).toLocaleDateString()},${row.workOrderCount},${row.totalQuantity}\n`
    })

    csv += '\n=== TOP/BOTTOM SKUs ===\n'
    csv += 'SKU,Item Name,Production Frequency,Avg Batch Size,Total Produced,UOM\n'
    overviewQuery.data.topBottomSKUs.forEach((row) => {
      const item = itemsMap.get(row.itemId)
      csv += `${item?.sku || row.itemId},${item?.name || 'Unknown'},${row.productionFrequency},${row.avgBatchSize},${row.totalProduced},${row.uom}\n`
    })

    csv += '\n=== WIP STATUS ===\n'
    csv += 'Status,Work Order Count,Total Planned,Total Completed\n'
    overviewQuery.data.wipStatus.forEach((row) => {
      csv += `${row.status},${row.workOrderCount},${row.totalPlanned},${row.totalCompleted}\n`
    })

    csv += '\n=== MATERIALS CONSUMED ===\n'
    csv += 'SKU,Item Name,UOM,Total Consumed,Work Orders,Executions\n'
    overviewQuery.data.materialsConsumed.forEach((row) => {
      const item = itemsMap.get(row.itemId)
      csv += `${item?.sku || row.itemId},${item?.name || 'Unknown'},${row.uom},${row.totalConsumed},${row.workOrderCount},${row.executionCount}\n`
    })

    downloadCSV(csv, 'production-overview-full')
  }

  const downloadCSV = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        {!hideTitle && <h1 className="text-2xl font-semibold text-slate-900">Production Overview</h1>}
        <p className="text-sm text-slate-600">
          Comprehensive production dashboard with volume trends, SKU performance, WIP status, and materials
          consumed
        </p>
      </div>

      {/* Filters */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">Filters</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Date From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Date To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Item</label>
              <select
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">All Items</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} - {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Location</label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">All Locations</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.code} - {loc.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDateFrom('')
                setDateTo('')
                setItemId('')
                setLocationId('')
              }}
            >
              Clear Filters
            </Button>
            <Button size="sm" variant="secondary" onClick={handleExportAll} disabled={!overviewQuery.data}>
              Export All to CSV
            </Button>
          </div>
        </div>
      </Card>

      {overviewQuery.isLoading && (
        <div className="py-12">
          <LoadingSpinner label="Loading production overview..." />
        </div>
      )}

      {overviewQuery.isError && (
        <ErrorState
          error={overviewQuery.error || { status: 500, message: 'An error occurred' }}
          onRetry={() => void overviewQuery.refetch()}
        />
      )}

      {overviewQuery.data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Production Volume Trend Chart */}
          <div className="lg:col-span-2">
            <Card>
              <div className="p-4 border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Production Volume Trend</h3>
                  <div className="flex gap-2">
                    <ChartExportButton
                      chartRef={volumeTrendChartRef}
                      chartName="production-volume-trend"
                      disabled={!overviewQuery.data.volumeTrend.length}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleExportVolumeTrend}
                      disabled={!overviewQuery.data.volumeTrend.length}
                    >
                      Export CSV
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-600 mt-1">Completed work orders by period</p>
              </div>
              <div className="p-4">
                {overviewQuery.data.volumeTrend.length === 0 ? (
                  <div className="text-center py-8 text-slate-600">No data available</div>
                ) : (
                  <div className="space-y-6">
                    {/* Chart View */}
                    <SimpleLineChart
                      chartRef={volumeTrendChartRef}
                      data={overviewQuery.data.volumeTrend.map(row => ({
                        name: new Date(row.period).toLocaleDateString(),
                        'Work Orders': row.workOrderCount,
                        'Total Quantity': row.totalQuantity,
                      }))}
                      xKey="name"
                      lines={[
                        { key: 'Work Orders', name: 'Work Orders', color: '#3b82f6' },
                        { key: 'Total Quantity', name: 'Total Quantity', color: '#10b981' }
                      ]}
                      yAxisFormatter={(value) => formatNumber(value)}
                    />
                    
                    {/* Table View (collapsible) */}
                    <details className="group">
                      <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900 flex items-center gap-2">
                        <span className="transform transition-transform group-open:rotate-90">▶</span>
                        Show Data Table
                      </summary>
                      <div className="overflow-x-auto mt-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200">
                              <th className="text-left py-2 px-3 font-medium text-slate-700">Date</th>
                              <th className="text-right py-2 px-3 font-medium text-slate-700">Work Orders</th>
                              <th className="text-right py-2 px-3 font-medium text-slate-700">Total Quantity</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewQuery.data.volumeTrend.map((row, idx) => (
                              <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                                <td className="py-2 px-3">{new Date(row.period).toLocaleDateString()}</td>
                                <td className="py-2 px-3 text-right">{row.workOrderCount}</td>
                                <td className="py-2 px-3 text-right">{formatNumber(row.totalQuantity)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* Top/Bottom SKUs Table */}
          <Card>
            <div className="p-4 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Top/Bottom SKUs</h3>
                <div className="flex gap-2">
                  <ChartExportButton
                    chartRef={topSKUsChartRef}
                    chartName="top-bottom-skus"
                    disabled={!overviewQuery.data.topBottomSKUs.length}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleExportTopBottomSKUs}
                    disabled={!overviewQuery.data.topBottomSKUs.length}
                  >
                    Export CSV
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-600 mt-1">By production frequency and batch size</p>
            </div>
            <div className="p-4">
              {overviewQuery.data.topBottomSKUs.length === 0 ? (
                <div className="text-center py-8 text-slate-600">No data available</div>
              ) : (
                <div className="space-y-6">
                  {/* Chart View */}
                  <SimpleBarChart
                    chartRef={topSKUsChartRef}
                    data={overviewQuery.data.topBottomSKUs.map((row) => {
                      const item = itemsMap.get(row.itemId)
                      return {
                        name: item?.sku || row.itemId,
                        'Total Produced': row.totalProduced,
                        'Avg Batch': row.avgBatchSize,
                        itemId: row.itemId,
                      }
                    })}
                    xKey="name"
                    bars={[
                      { key: 'Total Produced', name: 'Total Produced', color: '#3b82f6' },
                      { key: 'Avg Batch', name: 'Avg Batch', color: '#10b981' }
                    ]}
                    yAxisFormatter={(value) => formatNumber(value)}
                    layout="vertical"
                    height={Math.max(300, overviewQuery.data.topBottomSKUs.length * 40)}
                    onDataClick={(data) => {
                      if (data.itemId) {
                        navigate(`/items/${data.itemId}`)
                      }
                    }}
                  />
                  
                  {/* Table View (collapsible) */}
                  <details className="group">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900 flex items-center gap-2">
                      <span className="transform transition-transform group-open:rotate-90">▶</span>
                      Show Data Table
                    </summary>
                    <div className="overflow-x-auto max-h-96 mt-4">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-white">
                          <tr className="border-b border-slate-200">
                            <th className="text-left py-2 px-3 font-medium text-slate-700">Item</th>
                            <th className="text-right py-2 px-3 font-medium text-slate-700">Freq</th>
                            <th className="text-right py-2 px-3 font-medium text-slate-700">Avg Batch</th>
                            <th className="text-right py-2 px-3 font-medium text-slate-700">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overviewQuery.data.topBottomSKUs.map((row, idx) => {
                            const item = itemsMap.get(row.itemId)
                            return (
                              <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50 group">
                                <td className="py-2 px-3">
                                  <Link 
                                    to={`/items/${row.itemId}`}
                                    className="block"
                                  >
                                    <div className="font-medium text-brand-700 group-hover:underline">
                                      {item?.sku || row.itemId}
                                    </div>
                                    <div className="text-xs text-slate-600">{item?.name || 'Unknown'}</div>
                                  </Link>
                                </td>
                                <td className="py-2 px-3 text-right">{row.productionFrequency}</td>
                                <td className="py-2 px-3 text-right">
                                  {formatNumber(row.avgBatchSize)} {row.uom}
                                </td>
                                <td className="py-2 px-3 text-right">
                                  {formatNumber(row.totalProduced)} {row.uom}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              )}
            </div>
          </Card>

          {/* WIP Status Summary */}
          <Card>
            <div className="p-4 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">WIP Status Summary</h3>
                <div className="flex gap-2">
                  <ChartExportButton
                    chartRef={wipStatusChartRef}
                    chartName="wip-status-summary"
                    disabled={!overviewQuery.data.wipStatus.length}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleExportWIPStatus}
                    disabled={!overviewQuery.data.wipStatus.length}
                  >
                    Export CSV
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-600 mt-1">Work orders by status</p>
            </div>
            <div className="p-4">
              {overviewQuery.data.wipStatus.length === 0 ? (
                <div className="text-center py-8 text-slate-600">No data available</div>
              ) : (
                <div className="space-y-6">
                  {/* Chart View */}
                  <SimpleBarChart
                    chartRef={wipStatusChartRef}
                    data={overviewQuery.data.wipStatus.map((row) => ({
                      name: row.status,
                      'Work Orders': row.workOrderCount,
                      'Planned': row.totalPlanned,
                      'Completed': row.totalCompleted,
                      status: row.status,
                    }))}
                    xKey="name"
                    bars={[
                      { key: 'Planned', name: 'Planned', color: '#94a3b8' },
                      { key: 'Completed', name: 'Completed', color: '#10b981' }
                    ]}
                    yAxisFormatter={(value) => formatNumber(value)}
                    stacked={false}
                    onDataClick={(data) => {
                      if (data.status) {
                        navigate(`/work-orders?status=${data.status}`)
                      }
                    }}
                  />
                  
                  {/* Card View (collapsible) */}
                  <details className="group">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900 flex items-center gap-2">
                      <span className="transform transition-transform group-open:rotate-90">▶</span>
                      Show Status Cards
                    </summary>
                    <div className="space-y-3 mt-4">
                      {overviewQuery.data.wipStatus.map((row, idx) => (
                        <Link
                          key={idx}
                          to={`/work-orders?status=${row.status}`}
                          className="block border border-slate-200 rounded-lg p-3 hover:border-brand-500 hover:shadow-md transition-all"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <Badge
                              variant={
                                row.status === 'completed'
                                  ? 'success'
                                  : row.status === 'released'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {row.status}
                            </Badge>
                            <span className="text-sm font-medium text-brand-700">
                              {row.workOrderCount} WOs →
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <div className="text-slate-600">Planned</div>
                              <div className="font-medium">{formatNumber(row.totalPlanned)}</div>
                            </div>
                            <div>
                              <div className="text-slate-600">Completed</div>
                              <div className="font-medium">{formatNumber(row.totalCompleted)}</div>
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          </Card>

          {/* Materials Consumed Table */}
          <div className="lg:col-span-2">
            <Card>
              <div className="p-4 border-b border-slate-200">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Materials Consumed</h3>
                  <div className="flex gap-2">
                    <ChartExportButton
                      chartRef={materialsChartRef}
                      chartName="materials-consumed"
                      disabled={!overviewQuery.data.materialsConsumed.length}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleExportMaterialsConsumed}
                      disabled={!overviewQuery.data.materialsConsumed.length}
                    >
                      Export CSV
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-600 mt-1">From work order execution lines</p>
              </div>
              <div className="p-4">
                {overviewQuery.data.materialsConsumed.length === 0 ? (
                  <div className="text-center py-8 text-slate-600">No data available</div>
                ) : (
                  <div className="space-y-6">
                    {/* Chart View */}
                    <SimpleBarChart
                      chartRef={materialsChartRef}
                      data={overviewQuery.data.materialsConsumed.slice(0, 15).map((row) => {
                        const item = itemsMap.get(row.itemId)
                        return {
                          name: item?.sku || row.itemId,
                          'Total Consumed': row.totalConsumed,
                          itemId: row.itemId,
                        }
                      })}
                      xKey="name"
                      bars={[
                        { key: 'Total Consumed', name: 'Total Consumed', color: '#f59e0b' }
                      ]}
                      yAxisFormatter={(value) => formatNumber(value)}
                      layout="vertical"
                      height={Math.max(300, Math.min(overviewQuery.data.materialsConsumed.length, 15) * 35)}
                      onDataClick={(data) => {
                        if (data.itemId) {
                          navigate(`/items/${data.itemId}`)
                        }
                      }}
                    />
                    
                    {/* Table View (collapsible) */}
                    <details className="group">
                      <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900 flex items-center gap-2">
                        <span className="transform transition-transform group-open:rotate-90">▶</span>
                        Show Data Table
                      </summary>
                      <div className="overflow-x-auto mt-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200">
                              <th className="text-left py-2 px-3 font-medium text-slate-700">Item</th>
                              <th className="text-right py-2 px-3 font-medium text-slate-700">Total Consumed</th>
                              <th className="text-right py-2 px-3 font-medium text-slate-700">Work Orders</th>
                              <th className="text-right py-2 px-3 font-medium text-slate-700">Executions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewQuery.data.materialsConsumed.map((row, idx) => {
                              const item = itemsMap.get(row.itemId)
                              return (
                                <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50 group">
                                  <td className="py-2 px-3">
                                    <Link 
                                      to={`/items/${row.itemId}`}
                                      className="block"
                                    >
                                      <div className="font-medium text-brand-700 group-hover:underline">
                                        {item?.sku || row.itemId}
                                      </div>
                                      <div className="text-xs text-slate-600">{item?.name || 'Unknown'}</div>
                                    </Link>
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {formatNumber(row.totalConsumed)} {row.uom}
                                  </td>
                                  <td className="py-2 px-3 text-right">{row.workOrderCount}</td>
                                  <td className="py-2 px-3 text-right">{row.executionCount}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
