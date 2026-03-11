import { ClipboardDocumentIcon, PencilSquareIcon } from '@heroicons/react/24/outline'
import type { Item } from '../../../api/types'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { PageHeader } from '../../../shared/ui/PageHeader'

type Props = {
  item: Item
  onBack: () => void
  onEdit: () => void
  onAdjustStock: () => void
  onCopyId: () => void
  idCopied?: boolean
}

const typeLabels: Record<string, string> = {
  raw: 'Raw',
  wip: 'WIP',
  finished: 'Finished',
  packaging: 'Packaging',
}

function lifecycleVariant(status: Item['lifecycleStatus']) {
  if (status === 'Active') return 'success'
  if (status === 'Obsolete' || status === 'Phase-Out') return 'danger'
  return 'neutral'
}

export function ItemHeader({
  item,
  onBack,
  onEdit,
  onAdjustStock,
  onCopyId,
  idCopied = false,
}: Props) {
  return (
    <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm shadow-slate-950/5">
      <div className="bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.12),_transparent_36%),linear-gradient(180deg,rgba(248,250,252,0.94),rgba(255,255,255,1))] px-5 py-5 sm:px-7 sm:py-6">
        <PageHeader
          title={item.name}
          subtitle={`SKU ${item.sku} · Default UOM ${item.defaultUom || item.canonicalUom || '—'}`}
          meta={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={lifecycleVariant(item.lifecycleStatus)}>{item.lifecycleStatus}</Badge>
              <Badge variant="neutral">{typeLabels[item.type] ?? item.type}</Badge>
              <Badge variant="neutral">
                Default location {item.defaultLocationCode || item.defaultLocationName || '—'}
              </Badge>
            </div>
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onBack}>
                Back to list
              </Button>
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <PencilSquareIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Edit item
              </Button>
              <Button variant="secondary" size="sm" onClick={onAdjustStock}>
                Adjust stock
              </Button>
              <Button variant="secondary" size="sm" onClick={onCopyId}>
                <ClipboardDocumentIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {idCopied ? 'Copied' : 'Copy ID'}
              </Button>
            </div>
          }
        />
        {item.description ? (
          <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-600">{item.description}</p>
        ) : null}
      </div>
    </div>
  )
}
