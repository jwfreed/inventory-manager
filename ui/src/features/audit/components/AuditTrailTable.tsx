import type { AuditLogEntry } from '../../../api/types'
import { DataTable } from '@shared/ui'
import { formatDate } from '@shared/formatters'

type Props = {
  entries: AuditLogEntry[]
}

function formatActor(entry: AuditLogEntry) {
  const actorId = entry.actorId ?? '—'
  return `${entry.actorType}:${actorId}`
}

function formatMetadata(entry: AuditLogEntry) {
  if (!entry.metadata) return '—'
  try {
    return JSON.stringify(entry.metadata)
  } catch {
    return '—'
  }
}

export function AuditTrailTable({ entries }: Props) {
  if (!entries.length) {
    return <div className="text-sm text-slate-600">No audit events recorded yet.</div>
  }

  return (
    <DataTable
      rows={entries}
      rowKey={(entry) => entry.id}
      columns={[
        {
          id: 'occurredAt',
          header: 'When',
          cell: (entry) => formatDate(entry.occurredAt),
        },
        {
          id: 'action',
          header: 'Action',
          cell: (entry) => entry.action,
        },
        {
          id: 'actor',
          header: 'Actor',
          cell: (entry) => formatActor(entry),
        },
        {
          id: 'metadata',
          header: 'Metadata',
          cell: (entry) => formatMetadata(entry),
        },
      ]}
    />
  )
}
