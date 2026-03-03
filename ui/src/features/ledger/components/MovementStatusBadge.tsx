import { SeverityPill, type Severity } from '@shared/ui'

type Props = {
  status: string
}

export function MovementStatusBadge({ status }: Props) {
  const normalized = status?.toLowerCase()
  const severity: Severity =
    normalized === 'posted'
      ? 'info'
      : normalized === 'draft'
        ? 'watch'
        : normalized === 'canceled'
          ? 'critical'
          : 'info'

  return <SeverityPill severity={severity} label={status} />
}
