import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useItemsList } from '../queries'
import { Card, Badge, LoadingSpinner } from '@shared/ui'

export function AbcAnalysisCard() {
  const itemsQuery = useItemsList({ lifecycleStatus: 'Active' }, { staleTime: 60_000 })

  const abcSummary = useMemo(() => {
    const items = itemsQuery.data?.data ?? []
    const classA = items.filter((item) => item.abcClass === 'A')
    const classB = items.filter((item) => item.abcClass === 'B')
    const classC = items.filter((item) => item.abcClass === 'C')
    const unclassified = items.filter((item) => !item.abcClass)

    return {
      classA: classA.length,
      classB: classB.length,
      classC: classC.length,
      unclassified: unclassified.length,
      total: items.length,
    }
  }, [itemsQuery.data])

  if (itemsQuery.isLoading) {
    return (
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">ABC Classification</h3>
          <LoadingSpinner />
        </div>
      </Card>
    )
  }

  if (itemsQuery.isError) {
    return (
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">ABC Classification</h3>
          <p className="text-sm text-slate-600">Unable to load ABC data</p>
        </div>
      </Card>
    )
  }

  const total = abcSummary.total
  const percentA = total > 0 ? ((abcSummary.classA / total) * 100).toFixed(1) : '0'
  const percentB = total > 0 ? ((abcSummary.classB / total) * 100).toFixed(1) : '0'
  const percentC = total > 0 ? ((abcSummary.classC / total) * 100).toFixed(1) : '0'

  return (
    <Card>
      <div className="p-4">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">ABC Classification</h3>
        <p className="text-xs text-slate-600 mb-4">Items by revenue contribution</p>

        <div className="space-y-2">
          <Link
            to="/items?abcClass=A"
            className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-brand-500 hover:shadow-md transition-all group"
          >
            <div className="flex items-center gap-3">
              <Badge variant="success">A</Badge>
              <div>
                <div className="text-sm font-medium text-slate-900 group-hover:text-brand-700">
                  Class A Items
                </div>
                <div className="text-xs text-slate-600">High value, ~80% revenue</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-slate-900">{abcSummary.classA}</div>
              <div className="text-xs text-slate-600">{percentA}%</div>
            </div>
          </Link>

          <Link
            to="/items?abcClass=B"
            className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-brand-500 hover:shadow-md transition-all group"
          >
            <div className="flex items-center gap-3">
              <Badge variant="warning">B</Badge>
              <div>
                <div className="text-sm font-medium text-slate-900 group-hover:text-brand-700">
                  Class B Items
                </div>
                <div className="text-xs text-slate-600">Medium value, ~15% revenue</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-slate-900">{abcSummary.classB}</div>
              <div className="text-xs text-slate-600">{percentB}%</div>
            </div>
          </Link>

          <Link
            to="/items?abcClass=C"
            className="flex items-center justify-between p-3 border border-slate-200 rounded-lg hover:border-brand-500 hover:shadow-md transition-all group"
          >
            <div className="flex items-center gap-3">
              <Badge variant="neutral">C</Badge>
              <div>
                <div className="text-sm font-medium text-slate-900 group-hover:text-brand-700">
                  Class C Items
                </div>
                <div className="text-xs text-slate-600">Low value, ~5% revenue</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold text-slate-900">{abcSummary.classC}</div>
              <div className="text-xs text-slate-600">{percentC}%</div>
            </div>
          </Link>

          {abcSummary.unclassified > 0 && (
            <div className="flex items-center justify-between p-3 border border-slate-200 rounded-lg bg-slate-50">
              <div className="flex items-center gap-3">
                <Badge variant="neutral">—</Badge>
                <div>
                  <div className="text-sm font-medium text-slate-700">Unclassified</div>
                  <div className="text-xs text-slate-600">Not yet analyzed</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-slate-700">{abcSummary.unclassified}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
