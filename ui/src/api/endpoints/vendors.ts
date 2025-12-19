import { apiGet, apiPost, apiPut, apiDelete } from '../http'
import type { Vendor } from '../types'

export async function listVendors(params: { limit?: number; active?: boolean } = {}): Promise<{ data: Vendor[] }> {
  return apiGet<{ data: Vendor[] }>('/vendors', { params })
}

export type VendorPayload = {
  code: string
  name: string
  email?: string
  phone?: string
  active?: boolean
}

export async function createVendor(payload: VendorPayload): Promise<Vendor> {
  return apiPost<Vendor>('/vendors', payload)
}

export async function updateVendor(id: string, payload: VendorPayload): Promise<Vendor> {
  return apiPut<Vendor>(`/vendors/${id}`, payload)
}

export async function deleteVendor(id: string): Promise<Vendor> {
  return apiDelete<Vendor>(`/vendors/${id}`)
}
