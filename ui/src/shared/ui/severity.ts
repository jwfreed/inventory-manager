import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/solid'
import type { ComponentType, SVGProps } from 'react'

export type Severity = 'info' | 'watch' | 'action' | 'critical'

export type SeverityToken = {
  key: Severity
  label: string
  rank: number
  icon: ComponentType<SVGProps<SVGSVGElement>>
  textClassName: string
  pillClassName: string
  tintClassName: string
  borderClassName: string
  buttonClassName: string
}

export const severityTokens: Record<Severity, SeverityToken> = {
  info: {
    key: 'info',
    label: 'Info',
    rank: 1,
    icon: InformationCircleIcon,
    textClassName: 'text-sky-800',
    pillClassName: 'border border-sky-200 bg-sky-50 text-sky-800',
    tintClassName: 'bg-sky-50/60',
    borderClassName: 'border-sky-200',
    buttonClassName: 'focus-visible:outline-sky-500',
  },
  watch: {
    key: 'watch',
    label: 'Watch',
    rank: 2,
    icon: EyeIcon,
    textClassName: 'text-amber-800',
    pillClassName: 'border border-amber-200 bg-amber-50 text-amber-800',
    tintClassName: 'bg-amber-50/60',
    borderClassName: 'border-amber-200',
    buttonClassName: 'focus-visible:outline-amber-500',
  },
  action: {
    key: 'action',
    label: 'Action',
    rank: 3,
    icon: ExclamationTriangleIcon,
    textClassName: 'text-orange-800',
    pillClassName: 'border border-orange-200 bg-orange-50 text-orange-800',
    tintClassName: 'bg-orange-50/60',
    borderClassName: 'border-orange-200',
    buttonClassName: 'focus-visible:outline-orange-500',
  },
  critical: {
    key: 'critical',
    label: 'Critical',
    rank: 4,
    icon: ExclamationCircleIcon,
    textClassName: 'text-rose-800',
    pillClassName: 'border border-rose-200 bg-rose-50 text-rose-800',
    tintClassName: 'bg-rose-50/70',
    borderClassName: 'border-rose-300',
    buttonClassName: 'focus-visible:outline-rose-500',
  },
}

export function compareSeverity(left: Severity, right: Severity) {
  return severityTokens[right].rank - severityTokens[left].rank
}
