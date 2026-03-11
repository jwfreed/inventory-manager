import type { ReactNode } from 'react'

export type EntityPageLayoutProps = {
  header: ReactNode
  health?: ReactNode
  metrics?: ReactNode
  sectionNav?: ReactNode
  children: ReactNode
  contextRail?: ReactNode
}

export function EntityPageLayout({
  header,
  health,
  metrics,
  sectionNav,
  children,
  contextRail,
}: EntityPageLayoutProps) {
  return (
    <div className="mx-auto max-w-[1480px] space-y-6 pb-10">
      {header}
      {health}
      {metrics}
      {sectionNav}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <main className="space-y-6">{children}</main>
        {contextRail}
      </div>
    </div>
  )
}
