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
  isLegacy?: boolean
}
