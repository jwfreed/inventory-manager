export type ItemType = 'raw' | 'wip' | 'finished' | 'packaging'

export type Item = {
  id: string
  sku: string
  name: string
  description?: string | null
  type: ItemType
  isPhantom?: boolean
  defaultUom?: string | null
  defaultLocationId?: string | null
  defaultLocationCode?: string | null
  defaultLocationName?: string | null
  lifecycleStatus: 'Active' | 'In-Development' | 'Obsolete' | 'Phase-Out'
  standardCost?: number | null
  averageCost?: number | null
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

export type UomConversion = {
  id: string;
  itemId: string;
  fromUom: string;
  toUom: string;
  factor: number;
  createdAt: string;
  updatedAt: string;
};
