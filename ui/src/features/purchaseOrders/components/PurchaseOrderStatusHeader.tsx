import { Link } from 'react-router-dom'
import { Badge, Button } from '@shared/ui'

type StatusMeta = {
  label: string
  variant: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  dot: string
  helper: string
}

type Props = {
  vendorLabel: string
  poNumber: string
  status: StatusMeta
  canReceive?: boolean
  receiveHref?: string
}

export function PurchaseOrderStatusHeader({ vendorLabel, poNumber, status, canReceive, receiveHref }: Props) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <div className="text-base font-semibold text-slate-900">PO {poNumber}</div>
        <div className="mt-0.5 text-sm text-slate-600">{vendorLabel}</div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden="true" />
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="mt-1 text-xs text-slate-600">{status.helper}</div>
        </div>
        {canReceive && receiveHref && (
          <Link to={receiveHref}>
            <Button size="sm">Receive items</Button>
          </Link>
        )}
      </div>
    </div>
  )
}
