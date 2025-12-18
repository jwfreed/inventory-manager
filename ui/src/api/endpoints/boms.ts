import { apiGet, apiPost } from '../http'
import type { Bom } from '../types'

export type BomListByItemResponse = {
  itemId: string
  boms: Bom[]
}

export type BomComponentInput = {
  lineNumber: number
  componentItemId: string
  uom: string
  quantityPer: number
  scrapFactor?: number
  usesPackSize?: boolean
  variableUom?: string
  notes?: string
}

export type BomVersionInput = {
  versionNumber?: number
  effectiveFrom?: string
  effectiveTo?: string
  yieldQuantity: number
  yieldUom: string
  notes?: string
  components: BomComponentInput[]
}

export type BomCreatePayload = {
  bomCode: string
  outputItemId: string
  defaultUom: string
  notes?: string
  version: BomVersionInput
}

export type BomActivationPayload = {
  effectiveFrom: string
  effectiveTo?: string
}

export async function createBom(payload: BomCreatePayload): Promise<Bom> {
  return apiPost<Bom>('/boms', payload)
}

export async function getBom(id: string): Promise<Bom> {
  return apiGet<Bom>(`/boms/${id}`)
}

export async function listBomsByItem(itemId: string): Promise<BomListByItemResponse> {
  return apiGet<BomListByItemResponse>(`/items/${itemId}/boms`)
}

export async function activateBomVersion(versionId: string, payload: BomActivationPayload): Promise<Bom> {
  return apiPost<Bom>(`/boms/${versionId}/activate`, payload)
}
