export type AdjustmentLineDraft = {
  key: string
  itemId: string
  locationId: string
  uom: string
  quantityDelta: number | ''
  notes: string
}

export type AdjustmentDraft = {
  occurredAt: string
  reasonCode: string
  notes: string
  lines: AdjustmentLineDraft[]
}

export type ReasonCodeOption = {
  value: string
  label: string
  helper?: string
}

export const adjustmentReasonOptions: ReasonCodeOption[] = [
  { value: 'shrinkage', label: 'Shrinkage', helper: 'Inventory lost or missing.' },
  { value: 'damage', label: 'Damage', helper: 'Inventory damaged or spoiled.' },
  { value: 'found', label: 'Found stock', helper: 'Inventory discovered or added.' },
  { value: 'correction', label: 'Correction', helper: 'Fixing a prior adjustment.' },
  { value: 'other', label: 'Other', helper: 'Other inventory correction.' },
]
