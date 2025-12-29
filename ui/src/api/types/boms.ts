export type BomVersionComponent = {
  id: string
  bomVersionId: string
  lineNumber: number
  componentItemId: string
  componentItemSku?: string | null
  componentItemName?: string | null
  quantityPer: number
  uom: string
  scrapFactor: number | null
  usesPackSize?: boolean
  variableUom?: string | null
  notes: string | null
  createdAt: string
}

export type BomVersion = {
  id: string
  bomId: string
  versionNumber: number
  status: string
  effectiveFrom: string | null
  effectiveTo: string | null
  yieldQuantity: number
  yieldUom: string
  notes: string | null
  createdAt: string
  updatedAt: string
  components: BomVersionComponent[]
}

export type Bom = {
  id: string
  bomCode: string
  outputItemId: string
  defaultUom: string
  active: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  versions: BomVersion[]
}
