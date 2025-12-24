import { useMemo, useState } from 'react'
import type { WorkOrder } from '../../../api/types'
import { useItemsList } from '../../items/queries'
import { useWorkOrdersList } from '../queries'
import { Alert } from '../../../components/Alert'
import { Button } from '../../../components/Button'
import { Card } from '../../../components/Card'
import { EmptyState } from '../../../components/EmptyState'
import { LoadingSpinner } from '../../../components/Loading'
import { Section } from '../../../components/Section'
import { formatNumber } from '../../../lib/formatters'
import { useNavigate } from 'react-router-dom'
import { Badge } from '../../../components/Badge'

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Canceled', value: 'canceled' },
]

export default function WorkOrdersListPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const itemsQuery = useItemsList({ limit: 500 }, { staleTime: 60_000 })

  const { data, isLoading, isError, error, refetch, isFetching } = useWorkOrdersList({
    status: status || undefined,
    limit: 50,
  })

  const itemLookup = useMemo(() => {
    const map = new Map<string, { name?: string; sku?: string }>()
    itemsQuery.data?.data?.forEach((item) => {
      map.set(item.id, { name: item.name, sku: item.sku })
    })
    return map
  }, [itemsQuery.data])

  const filtered = useMemo(() => {
    const list = data?.data ?? []
    if (!search) return list
    const needle = search.toLowerCase()
    return list.filter((wo) => {
      const lookup = itemLookup.get(wo.outputItemId)
      const hay = `${wo.workOrderNumber} ${wo.outputItemSku ?? ''} ${wo.outputItemName ?? ''} ${lookup?.name ?? ''} ${lookup?.sku ?? ''} ${wo.outputItemId}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [data?.data, search, itemLookup])

  const remaining = (wo: WorkOrder) =>
    Math.max(0, (wo.quantityPlanned || 0) - (wo.quantityCompleted ?? 0))

  const formatOutput = (wo: WorkOrder) => {
    const lookup = wo.outputItemId ? itemLookup.get(wo.outputItemId) : undefined
    const name = wo.outputItemName || lookup?.name
    const sku = wo.outputItemSku || lookup?.sku
    if (name && sku) return `${name} — ${sku}`
    if (name) return name
    if (sku) return sku
    return wo.outputItemId
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">Execution</p>
        <h2 className="text-2xl font-semibold text-slate-900">Work Orders</h2>
        <p className="max-w-3xl text-sm text-slate-600">
          Drafts do not affect inventory. Posting issues creates issue movements; posting completions creates receive movements.
        </p>
        <div>
          <Button size="sm" onClick={() => navigate('/work-orders/new')}>
            New work order
          </Button>
        </div>
      </div>

      <Section title="Filters">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            disabled={isFetching}
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search work order number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={isFetching}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </Section>

      <Section title="Work orders">
        <Card>
          {isLoading && <LoadingSpinner label="Loading work orders..." />}
          {isError && error && (
            <Alert
              variant="error"
              title="Failed to load work orders"
              message={error.message}
              action={
                <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <EmptyState
              title="No work orders found"
              description="Adjust filters or create a work order via API."
            />
          )}
          {!isLoading && !isError && filtered.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      WO Number
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Output item
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Planned
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Completed
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Remaining
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filtered.map((wo) => (
                    <tr
                      key={wo.id}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => navigate(`/work-orders/${wo.id}`)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900">
                        {wo.workOrderNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-800">
                        <Badge variant="neutral">{wo.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        <div className="font-medium text-slate-900">{formatOutput(wo)}</div>
                        {(!wo.outputItemName && !wo.outputItemSku) && (
                          <div className="text-xs text-slate-500">{wo.outputItemId}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {formatNumber(wo.quantityPlanned)} {wo.outputUom}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {formatNumber(wo.quantityCompleted ?? 0)} {wo.outputUom}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-800">
                        {formatNumber(remaining(wo))} {wo.outputUom}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Section>
    </div>
  )
}
