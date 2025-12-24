export type InventorySnapshotRow = {
  itemId: string
  locationId: string
  uom: string
  onHand: number
  reserved: number
  available: number
  onOrder: number
  inTransit: number
  backordered: number
  inventoryPosition: number
}
