import { formatDateDisplay } from '../core/dateAdapter'

export function formatDate(value?: string | number | Date, locale = 'en-GB') {
  void locale
  return formatDateDisplay(value)
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
