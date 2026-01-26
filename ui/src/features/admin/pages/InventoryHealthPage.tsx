import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiError } from '../../../api/types'
import { getInventoryHealth } from '../api/inventoryHealth'
import { Badge } from '../../../components/Badge'

export default function InventoryHealthPage() {
  const healthQuery = useQuery({
    queryKey: ['inventory-health'],
    queryFn: () => getInventoryHealth(),
    retry: 1,
  })

  const health = healthQuery.data
  const gateStatus = health?.gate.pass ? 'pass' : 'fail'

  const ledgerOffenders = useMemo(() => health?.ledgerVsCostLayers.topOffenders ?? [], [health])
  const cycleOffenders = useMemo(() => health?.cycleCountVariance.topOffenders ?? [], [health])
  const negativeOffenders = useMemo(() => health?.negativeInventory.topOffenders ?? [], [health])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Inventory Health</h1>
        <p className="mt-1 text-sm text-slate-500">Perpetual inventory accuracy and variance checks.</p>
      </div>

      {healthQuery.isLoading && <div>Loading inventory health...</div>}
      {healthQuery.isError && (
        <div className="text-red-500">
          {(healthQuery.error as ApiError)?.message ?? 'Failed to load inventory health.'}
        </div>
      )}

      {health && (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Badge variant={gateStatus === 'pass' ? 'success' : 'danger'}>
              Gate {gateStatus === 'pass' ? 'PASS' : 'FAIL'}
            </Badge>
            <div className="text-sm text-slate-500">Generated {health.generatedAt}</div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard
              label="Ledger vs Cost Layers"
              value={`${health.ledgerVsCostLayers.variancePct.toFixed(2)}% variance`}
              subValue={`${health.ledgerVsCostLayers.rowsWithVariance}/${health.ledgerVsCostLayers.rowCount} rows`}
            />
            <MetricCard
              label="Cycle Count Variance"
              value={`${health.cycleCountVariance.variancePct.toFixed(2)}% variance`}
              subValue={`${health.cycleCountVariance.linesWithVariance}/${health.cycleCountVariance.totalLines} lines`}
            />
            <MetricCard
              label="Negative Inventory"
              value={`${health.negativeInventory.count} incidents`}
              subValue="Ledger on-hand < 0"
            />
          </div>

          <SectionTable
            title="Ledger vs Cost Layer Variance (Top Offenders)"
            rows={ledgerOffenders}
            columns={[
              { key: 'itemSku', label: 'SKU' },
              { key: 'locationCode', label: 'Location' },
              { key: 'uom', label: 'UOM' },
              { key: 'ledgerQty', label: 'Ledger Qty' },
              { key: 'layerQty', label: 'Layer Qty' },
              { key: 'varianceQty', label: 'Variance' },
            ]}
          />

          <SectionTable
            title="Cycle Count Variance (Top Offenders)"
            rows={cycleOffenders}
            columns={[
              { key: 'itemSku', label: 'SKU' },
              { key: 'locationCode', label: 'Location' },
              { key: 'uom', label: 'UOM' },
              { key: 'varianceQty', label: 'Variance' },
              { key: 'countedAt', label: 'Counted At' },
            ]}
          />

          <SectionTable
            title="Negative Inventory (Top Offenders)"
            rows={negativeOffenders}
            columns={[
              { key: 'itemSku', label: 'SKU' },
              { key: 'locationCode', label: 'Location' },
              { key: 'uom', label: 'UOM' },
              { key: 'onHand', label: 'On Hand' },
            ]}
          />
        </div>
      )}
    </div>
  )
}

function MetricCard({ label, value, subValue }: { label: string; value: string; subValue: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-lg font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{subValue}</div>
    </div>
  )
}

function SectionTable({
  title,
  rows,
  columns,
}: {
  title: string
  rows: Array<Record<string, unknown>>
  columns: Array<{ key: string; label: string }>
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">{title}</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="px-2 py-2">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-slate-500" colSpan={columns.length}>
                  No variance detected.
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr key={idx} className="border-t border-slate-100">
                  {columns.map((column) => (
                    <td key={column.key} className="px-2 py-2">
                      {String(row[column.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
