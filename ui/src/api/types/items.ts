export type ItemType = 'raw' | 'wip' | 'finished' | 'packaging'

export type Item = {
  id: string
  sku: string
  name: string
  description?: string | null
  type: ItemType
  isPhantom?: boolean
  defaultUom?: string | null
  uomDimension?: 'mass' | 'volume' | 'count' | 'length' | 'area' | 'time' | null
  canonicalUom?: string | null
  stockingUom?: string | null
  defaultLocationId?: string | null
  defaultLocationCode?: string | null
  defaultLocationName?: string | null
  requiresLot?: boolean
  requiresSerial?: boolean
  requiresQc?: boolean
  lifecycleStatus: 'Active' | 'In-Development' | 'Obsolete' | 'Phase-Out'
  abcClass?: 'A' | 'B' | 'C' | null
  standardCost?: number | null
  standardCostCurrency?: string | null
  standardCostExchangeRateToBase?: number | null
  standardCostBase?: number | null
  averageCost?: number | null
  sellingPrice?: number | null
  listPrice?: number | null
  priceCurrency?: string | null
  createdAt?: string
  updatedAt?: string
}

export type ItemInventoryRow = {
  locationId: string
  locationCode?: string
  locationName?: string
  uom: string
  onHand: number
  isLegacy?: boolean
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
