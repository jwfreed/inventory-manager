import type { ReactNode } from 'react'
import { Badge } from '../../components/Badge'
import { Panel } from './Panel'

export type ContextRailSection = {
  title: string
  description?: string
  items?: Array<{ label: string; value: ReactNode }>
  children?: ReactNode
}

type Props = {
  sections: ContextRailSection[]
}

export function ContextRail({ sections }: Props) {
  return (
    <aside className="space-y-4 xl:sticky xl:top-24 xl:w-[320px] xl:self-start">
      {sections.map((section) => (
        <Panel key={section.title} title={section.title} description={section.description}>
          {section.items ? (
            <div className="space-y-3">
              {section.items.map((item) => (
                <div
                  key={item.label}
                  className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3"
                >
                  <div className="text-sm text-slate-500">{item.label}</div>
                  <div className="text-right text-sm font-medium text-slate-900">{item.value}</div>
                </div>
              ))}
            </div>
          ) : null}
          {section.children}
        </Panel>
      ))}
    </aside>
  )
}

export function ConfigurationHealthPill({
  label,
  tone,
}: {
  label: string
  tone: 'success' | 'warning'
}) {
  return <Badge variant={tone === 'success' ? 'success' : 'warning'}>{label}</Badge>
}
