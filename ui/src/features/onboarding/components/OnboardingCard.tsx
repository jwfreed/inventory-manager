import type { ReactNode } from 'react'
import { Card } from '@shared/ui'

export default function OnboardingCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
        </div>
        {children}
      </div>
    </Card>
  )
}
