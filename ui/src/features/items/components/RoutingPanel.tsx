import { Panel } from '../../../shared/ui/Panel'
import { RoutingsCard } from '../../routings/components/RoutingsCard'

type Props = {
  itemId: string
}

export function RoutingPanel({ itemId }: Props) {
  return (
    <Panel
      title="Routing panel"
      description="Ordered manufacturing steps, versions, and work-center assignments."
    >
      <RoutingsCard itemId={itemId} />
    </Panel>
  )
}
