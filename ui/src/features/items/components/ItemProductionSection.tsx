import type { ApiError, Bom, BomVersion, Item } from '../../../api/types'
import { ConfigurationPanels } from './ConfigurationPanels'
import { BOMPanel } from './BOMPanel'
import { RoutingPanel } from './RoutingPanel'
import type { ItemDetailBomSummary } from '../hooks/useItemDetailPageModel'

type Props = {
  item: Item
  itemId: string
  summary: ItemDetailBomSummary
  boms: Bom[]
  isLoading: boolean
  error?: ApiError | null
  showComposer: boolean
  message?: string | null
  onToggleComposer: () => void
  onCreateWorkOrder: () => void
  onCreated: () => void
  onRefetch: () => void
  onDuplicate: (payload: { bom?: Bom; version?: BomVersion }) => void
}

export function ItemProductionSection(props: Props) {
  return (
    <section id="production" className="space-y-4 scroll-mt-24">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">Production</h2>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          Manufacturing definitions are kept in modular panels for BOMs and routings.
        </p>
      </div>
      <ConfigurationPanels>
        <BOMPanel
          item={props.item}
          summary={props.summary}
          boms={props.boms}
          isLoading={props.isLoading}
          error={props.error}
          showComposer={props.showComposer}
          message={props.message}
          onToggleComposer={props.onToggleComposer}
          onCreateWorkOrder={props.onCreateWorkOrder}
          onCreated={props.onCreated}
          onRefetch={props.onRefetch}
          onDuplicate={props.onDuplicate}
        />
        <RoutingPanel itemId={props.itemId} />
      </ConfigurationPanels>
    </section>
  )
}
