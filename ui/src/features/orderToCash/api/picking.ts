import { apiPost } from '../../../api/http'

export type PickBatch = {
  id: string
  status: string
  pickType: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export type PickTask = {
  id: string
  pickBatchId: string
  status: string
  inventoryReservationId?: string
  salesOrderLineId?: string
  itemId: string
  uom: string
  fromLocationId: string
  quantityRequested: number
  quantityPicked?: number
  pickedAt?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export type CreateWaveResponse = {
  batch: PickBatch
  tasks: PickTask[]
}

export async function createWave(salesOrderIds: string[]): Promise<CreateWaveResponse> {
  return apiPost<CreateWaveResponse>('/picking/waves', { salesOrderIds })
}
