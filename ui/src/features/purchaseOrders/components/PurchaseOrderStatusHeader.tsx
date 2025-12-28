import { Badge } from '@shared/ui'

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
}

export function PurchaseOrderStatusHeader({ vendorLabel, poNumber, status }: Props) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="text-sm text-slate-700">
        <div className="font-medium">Vendor: {vendorLabel}</div>
        <div className="text-xs text-slate-500">PO {poNumber}</div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-xs uppercase tracking-wide text-slate-500">Status</div>
        <div className="mt-1 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden="true" />
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <div className="mt-1 text-xs text-slate-600">{status.helper}</div>
      </div>
    </div>
  )
}
