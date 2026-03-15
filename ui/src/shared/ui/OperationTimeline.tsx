import { Link } from 'react-router-dom'
import { Badge } from '../../components/Badge'
import { EmptyState } from './EmptyState'
import { formatDate } from '@shared/formatters'

export type OperationTimelineItem = {
  id: string
  kindLabel: string
  title: string
  subtitle?: string
  statusLabel?: string
  occurredAt?: string | null
  postedAt?: string | null
  linkTo?: string | null
  metadata?: string[]
}

type Props = {
  items: OperationTimelineItem[]
  emptyTitle: string
  emptyDescription: string
}

export function OperationTimeline({ items, emptyTitle, emptyDescription }: Props) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  return (
    <ol className="space-y-4">
      {items.map((item) => (
        <li key={item.id} className="relative rounded-xl border border-slate-200 bg-white px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="neutral">{item.kindLabel}</Badge>
                {item.statusLabel ? (
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {item.statusLabel}
                  </span>
                ) : null}
              </div>
              <div>
                {item.linkTo ? (
                  <Link className="font-semibold text-brand-700 underline" to={item.linkTo}>
                    {item.title}
                  </Link>
                ) : (
                  <div className="font-semibold text-slate-900">{item.title}</div>
                )}
                {item.subtitle ? <div className="mt-1 text-sm text-slate-600">{item.subtitle}</div> : null}
              </div>
              {item.metadata?.length ? (
                <div className="space-y-1 text-xs text-slate-500">
                  {item.metadata.map((detail) => (
                    <div key={detail}>{detail}</div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="space-y-1 text-right text-xs text-slate-500">
              {item.occurredAt ? <div>Occurred {formatDate(item.occurredAt)}</div> : null}
              {item.postedAt ? <div>Posted {formatDate(item.postedAt)}</div> : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
