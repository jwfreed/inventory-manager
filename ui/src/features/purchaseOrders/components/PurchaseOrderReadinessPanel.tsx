import type { PurchaseOrderLineStats } from '../types'

type Props = {
  vendorId: string
  lineStats: PurchaseOrderLineStats
  orderDate: string
  expectedDate: string
}

export function PurchaseOrderReadinessPanel({ vendorId, lineStats, orderDate, expectedDate }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">Submission readiness</div>
      <ul className="mt-2 space-y-2 text-sm text-slate-700">
        <li className="flex items-center justify-between">
          <span>Vendor selected</span>
          <span>{vendorId ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>At least one line</span>
          <span>{lineStats.valid.length > 0 ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Quantities valid</span>
          <span>{lineStats.missingCount === 0 ? '✓' : '—'}</span>
        </li>
        <li className="flex items-center justify-between">
          <span>Dates set</span>
          <span>{orderDate && expectedDate ? '✓' : '—'}</span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Submit becomes available only when all checks are complete.
      </p>
    </div>
  )
}
