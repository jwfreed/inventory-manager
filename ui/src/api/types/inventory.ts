export type InventorySnapshotRow = {
  itemId: string
  locationId: string
  uom: string
  onHand: number
  reserved: number
  available: number
  held: number
  rejected: number
  nonUsable: number
  onOrder: number
  inTransit: number
  backordered: number
  inventoryPosition: number
}

export type InventoryChangeScope = {
  itemId?: string
  locationId?: string
}

export type InventoryChangeEvent = {
  seq: string
  type: string
  scope: InventoryChangeScope
  occurredAt: string
}

export type InventoryChangesResponse = {
  events: InventoryChangeEvent[]
  nextSeq: string
  resetRequired?: boolean
}
