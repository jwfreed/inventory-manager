import type { AdjustmentLineDraft } from './types'

export function makeLineKey() {
  return `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function toDateTimeLocal(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (num: number) => String(num).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export function toIsoFromDateTimeLocal(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

export function buildTotalsByUom(lines: AdjustmentLineDraft[]) {
  const totals = new Map<string, number>()
  lines.forEach((line) => {
    const qty = Number(line.quantityDelta)
    if (!line.uom || !Number.isFinite(qty)) return
    totals.set(line.uom, (totals.get(line.uom) ?? 0) + qty)
  })
  return Array.from(totals.entries()).map(([uom, quantityDelta]) => ({ uom, quantityDelta }))
}
