export type ItemType = 'raw' | 'wip' | 'finished' | 'packaging'

export type Item = {
  id: string
  sku: string
  name: string
  description?: string | null
  type: ItemType
  defaultUom?: string | null
  defaultLocationId?: string | null
  defaultLocationCode?: string | null
  defaultLocationName?: string | null
  active: boolean
  createdAt?: string
  updatedAt?: string
}

export type ItemInventoryRow = {
  locationId: string
  locationCode?: string
  locationName?: string
  uom: string
  onHand: number
}
