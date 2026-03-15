import type { ReactNode } from 'react'

type Props = {
  title: string
  message: string
  action?: ReactNode
}

export function ActionGuardMessage({ title, message, action }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="mt-1 text-sm text-slate-600">{message}</div>
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  )
}
