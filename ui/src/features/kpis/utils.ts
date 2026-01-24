export function formatDateTime(value?: string | null, locale = 'en-US') {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function getAgeInDays(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const diffMs = Date.now() - date.getTime()
  return diffMs / (1000 * 60 * 60 * 24)
}

export function isStale(value?: string | null, thresholdDays: number) {
  const age = getAgeInDays(value)
  if (age === null) return false
  return age > thresholdDays
}
