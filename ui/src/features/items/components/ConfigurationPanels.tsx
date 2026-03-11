import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
}

export function ConfigurationPanels({ children }: Props) {
  return <div className="space-y-5">{children}</div>
}
