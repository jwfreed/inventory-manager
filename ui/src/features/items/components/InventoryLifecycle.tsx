import { formatNumber } from '@shared/formatters'
import { cn } from '../../../lib/utils'
import { Tooltip } from '../../../shared/ui/Tooltip'
import type { InventoryLifecycleStage } from '../itemDetail.models'

type Props = {
  stages: InventoryLifecycleStage[]
  uom?: string | null
}

const toneStyles: Record<InventoryLifecycleStage['tone'], string> = {
  neutral: 'border-slate-200 bg-white',
  warning: 'border-amber-200 bg-amber-50/70',
  danger: 'border-rose-200 bg-rose-50/70',
}

export function InventoryLifecycle({ stages, uom }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {stages.map((stage, index) => (
        <div key={stage.key} className="relative">
          <div className={cn('rounded-2xl border px-4 py-4', toneStyles[stage.tone])}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                {stage.label}
              </div>
              <Tooltip label={stage.description} />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {formatNumber(stage.quantity)}
            </div>
            {uom ? <div className="mt-1 text-sm text-slate-500">{uom}</div> : null}
          </div>
          {index < stages.length - 1 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-[-10px] top-1/2 hidden h-px w-5 -translate-y-1/2 bg-slate-300 xl:block"
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
