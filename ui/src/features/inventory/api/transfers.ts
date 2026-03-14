import { apiPost } from '../../../api/http'
import type { InventoryTransferResult } from '../../../api/types'
import { buildIdempotencyHeaders, createIdempotencyKey } from '../../../lib/idempotency'

export type InventoryTransferCreatePayload = {
  sourceLocationId: string
  destinationLocationId: string
  warehouseId?: string
  itemId: string
  quantity: number
  uom: string
  occurredAt?: string
  reasonCode?: string
  notes?: string
}

export async function createInventoryTransfer(
  payload: InventoryTransferCreatePayload,
): Promise<InventoryTransferResult> {
  const idempotencyKey = createIdempotencyKey('inventory-transfer')
  return apiPost<InventoryTransferResult>(
    '/inventory-transfers',
    payload,
    {
      headers: buildIdempotencyHeaders(idempotencyKey),
    },
  )
}
