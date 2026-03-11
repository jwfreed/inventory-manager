import { formatCurrency, formatDate } from '@shared/formatters'
import type { Item } from '../../../api/types'
import { Button } from '../../../components/Button'
import { Panel } from '../../../shared/ui'

type Props = {
  item: Item
  baseCurrency: string
  onViewLedger: () => void
}

export function ItemHistorySection({ item, baseCurrency, onViewLedger }: Props) {
  return (
    <section id="history" className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">History</h2>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          Movement and change context without pulling metadata into the primary work surface.
        </p>
      </div>

      <Panel
        title="Supporting history"
        description="Use the movement ledger for detailed traceability and issue investigation."
        actions={
          <Button variant="secondary" size="sm" onClick={onViewLedger}>
            View movement ledger
          </Button>
        }
      >
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Created</div>
            <div className="mt-2 text-base font-semibold text-slate-950">
              {item.createdAt ? formatDate(item.createdAt) : '—'}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Updated</div>
            <div className="mt-2 text-base font-semibold text-slate-950">
              {item.updatedAt ? formatDate(item.updatedAt) : '—'}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Costing</div>
            <div className="mt-2 text-base font-semibold text-slate-950">
              {item.averageCost != null
                ? formatCurrency(item.averageCost, baseCurrency)
                : item.standardCost != null
                  ? formatCurrency(item.standardCost, item.standardCostCurrency ?? baseCurrency)
                  : 'Not set'}
            </div>
          </div>
        </div>
      </Panel>
    </section>
  )
}
