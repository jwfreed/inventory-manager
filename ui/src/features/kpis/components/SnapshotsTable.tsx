import { useEffect, useMemo, useState } from 'react'
import type { KpiSnapshot } from '../../../api/types'
import { Card } from '../../../components/Card'
import { Input, Select } from '../../../components/Inputs'
import { Table } from '../../../components/Table'
import { formatNumber } from '../../../lib/formatters'
import { formatDateTime } from '../utils'
import { DimensionsCell } from './DimensionsCell'

type Props = {
  snapshots: KpiSnapshot[]
}

const PAGE_SIZE = 15

export function SnapshotsTable({ snapshots }: Props) {
  const [kpiFilter, setKpiFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    setPage(1)
  }, [kpiFilter, fromDate, toDate])

  const uniqueKpis = useMemo(
    () => Array.from(new Set(snapshots.map((s) => s.kpi_name))).sort(),
    [snapshots],
  )

  const filtered = useMemo(() => {
    return snapshots
      .filter((snapshot) => {
        if (kpiFilter && snapshot.kpi_name !== kpiFilter) return false

        const ts = new Date(snapshot.computed_at || 0).getTime()
        if (fromDate) {
          const fromTs = new Date(fromDate).getTime()
          if (!Number.isNaN(fromTs) && ts < fromTs) return false
        }
        if (toDate) {
          const toTs = new Date(toDate).getTime()
          if (!Number.isNaN(toTs) && ts > toTs) return false
        }
        return true
      })
      .sort(
        (a, b) =>
          new Date(b.computed_at || 0).getTime() - new Date(a.computed_at || 0).getTime(),
      )
  }, [snapshots, kpiFilter, fromDate, toDate])

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  return (
    <Card
      title="Recent KPI snapshots"
      description="Filter by KPI name or date range. Values are shown exactly as provided by the backend."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            KPI name
          </label>
          <Select value={kpiFilter} onChange={(e) => setKpiFilter(e.target.value)}>
            <option value="">All KPIs</option>
            {uniqueKpis.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            From
          </label>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            To
          </label>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>

      <Table<KpiSnapshot>
        data={paged}
        columns={[
          {
            header: 'Computed at',
            accessor: 'computed_at',
            render: (value) => formatDateTime(value as string),
          },
          {
            header: 'KPI name',
            accessor: 'kpi_name',
          },
          {
            header: 'Value',
            accessor: 'value',
            render: (value) => {
              if (value === null || value === undefined) return '—'
              if (typeof value === 'number') return formatNumber(value)
              if (typeof value === 'string') return value
              return JSON.stringify(value)
            },
          },
          {
            header: 'Unit',
            accessor: 'unit',
            render: (value) => (value ? String(value) : '—'),
          },
          {
            header: 'Dimensions',
            accessor: 'dimensions',
            render: (_, row) => <DimensionsCell dimensions={row.dimensions} />,
          },
        ]}
        pagination={{
          page,
          pageCount,
          onPageChange: setPage,
        }}
      />
    </Card>
  )
}
