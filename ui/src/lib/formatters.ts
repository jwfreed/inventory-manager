export function formatDate(value?: string | number | Date, locale = 'en-US') {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatNumber(value?: number, locale = 'en-US') {
  if (value === undefined || value === null) return ''
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
}

export function formatCurrency(value?: number, currency = 'USD', locale = 'en-US') {
  if (value === undefined || value === null) return ''
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value)
}
