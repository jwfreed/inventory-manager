import type { PurchaseOrder } from '@api/types'
import { Card } from '@shared/ui'

type Props = {
  grouped: {
    draft: PurchaseOrder[]
    submitted: PurchaseOrder[]
    approved: PurchaseOrder[]
  }
  staleDraftCount: number
}

export function PurchaseOrdersSummaryCards({ grouped, staleDraftCount }: Props) {
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-3">
      <Card className="p-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">Drafts</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.draft.length}</div>
        <div className="text-xs text-slate-500">Safe, not committed</div>
        {staleDraftCount > 0 && (
          <div className="mt-2 text-xs text-amber-700">{staleDraftCount} older than 7 days</div>
        )}
      </Card>
      <Card className="p-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">Submitted</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.submitted.length}</div>
        <div className="text-xs text-slate-500">Awaiting approval</div>
      </Card>
      <Card className="p-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">Approved</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{grouped.approved.length}</div>
        <div className="text-xs text-slate-500">Awaiting receipt</div>
      </Card>
    </div>
  )
}
