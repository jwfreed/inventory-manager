import { Badge } from '../../../components/Badge'
import { Card } from '../../../components/Card'
import { formatNumber } from '@shared/formatters'
import type { WorkOrder } from '../../../api/types'

type Props = {
  workOrder: WorkOrder
  outputItemLabel?: string
}

export function WorkOrderHeader({ workOrder, outputItemLabel }: Props) {
  const remaining =
    (workOrder.quantityPlanned || 0) - (workOrder.quantityCompleted ?? 0)

  const statusVariant =
    workOrder.status === 'completed'
      ? 'success'
      : workOrder.status === 'in_progress'
        ? 'info'
        : workOrder.status === 'canceled'
          ? 'danger'
          : 'warning'

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Work order</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">
            {workOrder.workOrderNumber}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={statusVariant}>{workOrder.status}</Badge>
            <Badge variant="neutral">
              Output: {outputItemLabel || workOrder.outputItemName || workOrder.outputItemSku || workOrder.outputItemId}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-sm text-slate-700">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Planned</div>
            <div className="mt-1 font-semibold">
              {formatNumber(workOrder.quantityPlanned)} {workOrder.outputUom}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Completed</div>
            <div className="mt-1 font-semibold">
              {formatNumber(workOrder.quantityCompleted ?? 0)} {workOrder.outputUom}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Remaining</div>
            <div className="mt-1 font-semibold">
              {formatNumber(Math.max(0, remaining))} {workOrder.outputUom}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
