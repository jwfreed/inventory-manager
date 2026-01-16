export type Movement = {
  id: string
  movementType: string
  status: string
  occurredAt: string
  postedAt?: string | null
  externalRef?: string | null
  notes?: string | null
  metadata?: Record<string, unknown> | null
  createdAt?: string
  updatedAt?: string
}

export type MovementLine = {
  id: string
  movementId: string
  itemId: string
  itemSku?: string
  itemName?: string
  locationId: string
  locationCode?: string
  locationName?: string
  uom: string
  quantityDelta: number
  reasonCode?: string | null
  lineNotes?: string | null
}

export type MovementListResponse = {
  data: Movement[]
  paging?: { limit: number; offset: number }
}

export type MovementWindow = {
  occurredFrom: string
  occurredTo: string
}
