import type { BadgeVariant } from '../../components/Badge'
import type { Severity } from './severity'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'critical'

const successStatuses = new Set(['ready', 'active', 'completed', 'closed'])
const infoStatuses = new Set(['posted', 'in progress', 'in_progress', 'partially completed', 'partially_completed'])
const warningStatuses = new Set([
  'warning',
  'watch',
  'missing',
  'optional',
  'draft',
  'late posted',
  'phase-out',
  'phase out',
])
const dangerStatuses = new Set(['blocked', 'canceled', 'cancelled', 'inactive', 'obsolete', 'anomaly'])
const criticalStatuses = new Set(['critical'])

export function formatStatusLabel(value?: string | null) {
  if (!value) return 'Unknown'
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function statusTone(value?: string | null): StatusTone {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return 'neutral'
  if (criticalStatuses.has(normalized)) return 'critical'
  if (dangerStatuses.has(normalized)) return 'danger'
  if (warningStatuses.has(normalized)) return 'warning'
  if (successStatuses.has(normalized)) return 'success'
  if (infoStatuses.has(normalized)) return 'info'
  return 'neutral'
}

export function statusToneToSeverity(tone: StatusTone): Severity {
  switch (tone) {
    case 'critical':
      return 'critical'
    case 'danger':
      return 'action'
    case 'warning':
      return 'watch'
    case 'success':
    case 'info':
    case 'neutral':
    default:
      return 'info'
  }
}

export function statusToneToBadgeVariant(tone: StatusTone): BadgeVariant {
  switch (tone) {
    case 'success':
      return 'success'
    case 'info':
      return 'info'
    case 'warning':
      return 'warning'
    case 'danger':
    case 'critical':
      return 'danger'
    case 'neutral':
    default:
      return 'neutral'
  }
}
