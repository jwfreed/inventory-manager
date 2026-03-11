import { StatusCell, formatStatusLabel, statusTone } from '@shared/ui'

type Props = {
  status: string
  meta?: string
  compact?: boolean
}

export function MovementStatusBadge({ status, meta, compact }: Props) {
  return <StatusCell label={formatStatusLabel(status)} tone={statusTone(status)} meta={meta} compact={compact} />
}
