export type Location = {
  id: string
  code: string
  name: string
  type: string
  active: boolean
  parentLocationId?: string | null
  path?: string | null
  depth?: number | null
  createdAt?: string
  updatedAt?: string
}

export type LocationInventoryRow = {
  itemId: string
  itemSku?: string
  itemName?: string
  uom: string
  onHand: number
}
