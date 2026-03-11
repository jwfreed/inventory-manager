import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
}

export function MetricGrid({ children }: Props) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{children}</div>
}
