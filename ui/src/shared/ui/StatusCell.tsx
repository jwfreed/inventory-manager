import { Badge } from '../../components/Badge'
import { cn } from '../../lib/utils'
import { SeverityPill } from './SeverityPill'
import type { StatusTone } from './statusTone'
import { statusToneToBadgeVariant, statusToneToSeverity } from './statusTone'

export type StatusCellProps = {
  label: string
  tone: StatusTone
  meta?: string
  compact?: boolean
}

export function StatusCell({ label, tone, meta, compact = false }: StatusCellProps) {
  const chip =
    tone === 'critical' ? (
      <SeverityPill severity={statusToneToSeverity(tone)} label={label} />
    ) : (
      <Badge variant={statusToneToBadgeVariant(tone)}>{label}</Badge>
    )

  return (
    <div className={cn('flex flex-col gap-1', compact && 'gap-0.5')}>
      <div>{chip}</div>
      {meta ? <div className="text-xs text-slate-500">{meta}</div> : null}
    </div>
  )
}
