import { Badge } from '../../../components/Badge'

type Props = {
  status: string
}

export function MovementStatusBadge({ status }: Props) {
  const normalized = status?.toLowerCase()
  const variant =
    normalized === 'posted'
      ? 'success'
      : normalized === 'draft'
        ? 'warning'
        : normalized === 'canceled'
          ? 'danger'
          : 'neutral'

  return <Badge variant={variant}>{status}</Badge>
}
