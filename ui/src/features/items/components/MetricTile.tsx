import { cn } from '../../../lib/utils'

export type MetricTileProps = {
  label: string
  value: string | number
  subtext?: string
  status?: 'neutral' | 'warning' | 'danger'
}

const statusStyles: Record<NonNullable<MetricTileProps['status']>, string> = {
  neutral: 'border-slate-200 bg-slate-50/70',
  warning: 'border-amber-200 bg-amber-50/80',
  danger: 'border-rose-200 bg-rose-50/80',
}

export function MetricTile({
  label,
  value,
  subtext,
  status = 'neutral',
}: MetricTileProps) {
  return (
    <div className={cn('rounded-2xl border px-4 py-4', statusStyles[status])}>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</div>
      {subtext ? <div className="mt-2 text-sm leading-5 text-slate-600">{subtext}</div> : null}
    </div>
  )
}
