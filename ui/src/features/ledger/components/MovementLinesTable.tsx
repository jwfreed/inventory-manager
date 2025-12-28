import { formatNumber } from '@shared/formatters'
import type { MovementLine } from '../../../api/types'
import { cn } from '../../../lib/utils'

type Props = {
  lines: MovementLine[]
}

export function MovementLinesTable({ lines }: Props) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Item
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Location
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              UOM
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
              Quantity Δ
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Reason
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-sm text-slate-500">
                No lines found.
              </td>
            </tr>
          ) : (
            lines.map((line) => {
              const qty = line.quantityDelta ?? 0
              const sign = qty > 0 ? '+' : qty < 0 ? '−' : ''
              return (
                <tr key={line.id}>
                  <td className="px-4 py-3 text-sm text-slate-800">
                    {line.itemSku || line.itemName ? (
                      <div>
                        <div className="font-medium">{line.itemSku || line.itemName}</div>
                        {line.itemName && line.itemSku && (
                          <div className="text-xs text-slate-500">{line.itemName}</div>
                        )}
                      </div>
                    ) : (
                      line.itemId
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-800">
                    {line.locationCode || line.locationName || line.locationId}
                    {line.locationName && (
                      <div className="text-xs text-slate-500">{line.locationName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-800">{line.uom}</td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right text-sm font-semibold',
                      qty > 0 ? 'text-green-700' : qty < 0 ? 'text-red-600' : 'text-slate-700',
                    )}
                  >
                    {sign}
                    {formatNumber(Math.abs(qty))}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">{line.reasonCode || '—'}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
