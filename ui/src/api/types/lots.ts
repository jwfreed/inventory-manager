export type Lot = {
  id: string
  itemId: string
  lotCode: string
  status: string
  manufacturedAt?: string | null
  receivedAt?: string | null
  expiresAt?: string | null
  vendorLotCode?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
}

export type MovementLotAllocation = {
  id: string
  inventoryMovementLineId: string
  lotId: string
  uom: string
  quantityDelta: number
  createdAt?: string
}
