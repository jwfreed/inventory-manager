import type { Item } from '../../../api/types'
import { Panel } from '../../../shared/ui'
import { ItemForm } from './ItemForm'

type Props = {
  item: Item
  onSaved: () => void
}

export function ItemEditPanel({ item, onSaved }: Props) {
  return (
    <Panel title="Edit item" description="Inline editor for master data and default policies.">
      <ItemForm initialItem={item} onSuccess={onSaved} />
    </Panel>
  )
}
