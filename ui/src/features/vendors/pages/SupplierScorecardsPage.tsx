import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getSupplierScorecards,
  getTopSuppliersByDelivery,
  getTopSuppliersByQuality,
  getSuppliersWithQualityIssues,
} from '@api/reports'
import type { SupplierScorecard } from '@api/types'
import { LoadingSpinner, ErrorState, Badge, Section } from '@shared/ui'

export function SupplierScorecardsPage() {
  const [activeTab, setActiveTab] = useState<'all' | 'delivery' | 'quality' | 'issues'>('all')

  const allQuery = useQuery({
    queryKey: ['supplier-scorecards'],
    queryFn: () => getSupplierScorecards(),
    enabled: activeTab === 'all',
    staleTime: 300_000, // 5 minutes
  })

  const deliveryQuery = useQuery({
    queryKey: ['supplier-scorecards-delivery'],
    queryFn: () => getTopSuppliersByDelivery(10),
    enabled: activeTab === 'delivery',
    staleTime: 300_000,
  })

  const qualityQuery = useQuery({
    queryKey: ['supplier-scorecards-quality'],
    queryFn: () => getTopSuppliersByQuality(10),
    enabled: activeTab === 'quality',
    staleTime: 300_000,
  })

  const issuesQuery = useQuery({
    queryKey: ['supplier-scorecards-issues'],
    queryFn: () => getSuppliersWithQualityIssues(),
    enabled: activeTab === 'issues',
    staleTime: 300_000,
  })

  const activeQuery = {
    all: allQuery,
    delivery: deliveryQuery,
    quality: qualityQuery,
    issues: issuesQuery,
  }[activeTab]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Supplier Scorecards</h1>
        <p className="mt-1 text-sm text-gray-500">
          Track vendor performance across delivery and quality metrics
        </p>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <TabButton
            active={activeTab === 'all'}
            onClick={() => setActiveTab('all')}
            label="All Suppliers"
          />
          <TabButton
            active={activeTab === 'delivery'}
            onClick={() => setActiveTab('delivery')}
            label="Top Delivery"
            icon="🚚"
          />
          <TabButton
            active={activeTab === 'quality'}
            onClick={() => setActiveTab('quality')}
            label="Top Quality"
            icon="✓"
          />
          <TabButton
            active={activeTab === 'issues'}
            onClick={() => setActiveTab('issues')}
            label="Quality Issues"
            icon="⚠"
          />
        </nav>
      </div>

      <Section>
        {activeQuery.isLoading ? (
          <LoadingSpinner />
        ) : activeQuery.error ? (
          <ErrorState error={{ status: 500, message: 'Failed to load supplier scorecards. Please try again.' }} />
        ) : !activeQuery.data?.data?.length ? (
          <div className="text-center py-12">
            <p className="text-gray-500">No suppliers found for this view.</p>
          </div>
        ) : (
          <ScorecardTable
            scorecards={activeQuery.data.data}
            highlightMetric={
              activeTab === 'delivery' ? 'delivery' : activeTab === 'quality' ? 'quality' : undefined
            }
          />
        )}
      </Section>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`
        whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm
        ${
          active
            ? 'border-blue-500 text-blue-600'
            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
        }
      `}
    >
      {icon && <span className="mr-2">{icon}</span>}
      {label}
    </button>
  )
}

function ScorecardTable({
  scorecards,
  highlightMetric,
}: {
  scorecards: SupplierScorecard[]
  highlightMetric?: 'delivery' | 'quality'
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Vendor
            </th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Purchase Orders
            </th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Receipts
            </th>
            <th
              className={`px-6 py-3 text-center text-xs font-medium uppercase tracking-wider ${
                highlightMetric === 'delivery' ? 'bg-green-50 text-green-700' : 'text-gray-500'
              }`}
            >
              On-Time Delivery
            </th>
            <th
              className={`px-6 py-3 text-center text-xs font-medium uppercase tracking-wider ${
                highlightMetric === 'quality' ? 'bg-blue-50 text-blue-700' : 'text-gray-500'
              }`}
            >
              Quality Rate
            </th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              NCRs
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {scorecards.map((scorecard) => (
            <tr key={scorecard.vendorId} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">{scorecard.vendorName}</div>
                <div className="text-sm text-gray-500">{scorecard.vendorCode}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center text-sm text-gray-600">
                {scorecard.totalPurchaseOrders}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                <div className="text-sm text-gray-900">{scorecard.totalReceipts}</div>
                <div className="text-xs text-gray-500">
                  {scorecard.onTimeReceipts} on-time, {scorecard.lateReceipts} late
                </div>
              </td>
              <td
                className={`px-6 py-4 whitespace-nowrap text-center ${
                  highlightMetric === 'delivery' ? 'bg-green-50' : ''
                }`}
              >
                <RateBadge rate={scorecard.onTimeDeliveryRate} />
                {scorecard.averageDaysLate && scorecard.averageDaysLate > 0 && (
                  <div className="text-xs text-gray-500 mt-1">
                    Avg {scorecard.averageDaysLate.toFixed(1)}d late
                  </div>
                )}
              </td>
              <td
                className={`px-6 py-4 whitespace-nowrap text-center ${
                  highlightMetric === 'quality' ? 'bg-blue-50' : ''
                }`}
              >
                <RateBadge rate={scorecard.qualityRate} />
                {scorecard.totalQcEvents > 0 && (
                  <div className="text-xs text-gray-500 mt-1">
                    {scorecard.acceptedQuantity} accepted, {scorecard.rejectedQuantity} rejected
                  </div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                <div className="flex items-center justify-center gap-2">
                  <Badge variant={scorecard.openNcrs > 0 ? 'warning' : 'neutral'}>
                    {scorecard.totalNcrs} total
                  </Badge>
                  {scorecard.openNcrs > 0 && (
                    <Badge variant="danger">{scorecard.openNcrs} open</Badge>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RateBadge({ rate }: { rate: number }) {
  const getVariant = () => {
    if (rate >= 95) return 'success'
    if (rate >= 85) return 'warning'
    return 'danger'
  }

  const getIcon = () => {
    if (rate >= 95) return '✓'
    if (rate >= 85) return '~'
    return '✗'
  }

  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-lg">{getIcon()}</span>
      <Badge variant={getVariant()}>{rate.toFixed(1)}%</Badge>
    </div>
  )
}
