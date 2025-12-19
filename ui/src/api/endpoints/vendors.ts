import { apiGet } from '../http'
import type { Vendor } from '../types'

export async function listVendors(params: { limit?: number; active?: boolean } = {}): Promise<{ data: Vendor[] }> {
  return apiGet<{ data: Vendor[] }>('/vendors', { params })
}
