export type ApiError = {
  status: number
  message: string
  details?: unknown
}

export type ApiResult<T> = {
  data?: T
  error?: ApiError
}

export type Movement = {
  id: string
  movementType: string
  status: string
  occurredAt: string
  postedAt?: string | null
  externalRef?: string | null
  notes?: string | null
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
  notes?: string | null
}

export type MovementListResponse = {
  data: Movement[]
  total?: number
  page?: number
  pageSize?: number
}
