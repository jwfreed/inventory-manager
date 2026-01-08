import type { ReactNode } from 'react'

type Props = {
  label: string
  children: ReactNode
  helper?: string
  error?: string
  required?: boolean
  className?: string
}

export function FormField({ label, children, helper, error, required, className = '' }: Props) {
  return (
    <label className={`space-y-1 text-sm ${className}`}>
      <span className="text-xs uppercase tracking-wide text-slate-500">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
      {helper && <span className="text-xs text-slate-600">{helper}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </label>
  )
}
