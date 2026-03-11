import { Card } from '../../../components/Card'
import { RoutingsCard } from '../../routings/components/RoutingsCard'

type Props = {
  itemId: string
}

export function RoutingPanel({ itemId }: Props) {
  return (
    <Card
      title="Routing panel"
      description="Ordered manufacturing steps, versions, and work-center assignments."
      className="rounded-[24px] border-slate-200 shadow-sm shadow-slate-950/5"
    >
      <RoutingsCard itemId={itemId} />
    </Card>
  )
}
