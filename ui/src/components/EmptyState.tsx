import type { ReactNode } from 'react'
import { EmptyState as PrimitiveEmptyState, type EmptyStateProps as PrimitiveEmptyStateProps } from '../shared/ui/EmptyState'

type Props = PrimitiveEmptyStateProps & {
  icon?: ReactNode
}

export function EmptyState({ icon, ...props }: Props) {
  if (!icon) {
    return <PrimitiveEmptyState {...props} />
  }

  return (
    <PrimitiveEmptyState
      {...props}
      description={
        <span className="inline-flex items-start gap-3">
          <span className="text-slate-500">{icon}</span>
          <span>{props.description}</span>
        </span>
      }
    />
  )
}
