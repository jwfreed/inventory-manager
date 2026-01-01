export type Location = {
  id: string
  code: string
  name: string
  type: string
  active: boolean
  parentLocationId?: string | null
  path?: string | null
  depth?: number | null
  maxWeight?: number | null
  maxVolume?: number | null
  zone?: string | null
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
