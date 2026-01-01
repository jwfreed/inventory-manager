import { apiGet, apiPatch } from '../../../api/http'
import type { Ncr, NcrUpdateInput } from '../types'

export async function listNcrs(status?: 'open' | 'closed'): Promise<{ data: Ncr[] }> {
  const params = new URLSearchParams()
  if (status) params.append('status', status)
  return apiGet<{ data: Ncr[] }>(`/ncrs?${params.toString()}`)
}

export async function getNcr(id: string): Promise<Ncr> {
  return apiGet<Ncr>(`/ncrs/${id}`)
}

export async function updateNcrDisposition(id: string, data: NcrUpdateInput): Promise<Ncr> {
  return apiPatch<Ncr>(`/ncrs/${id}/disposition`, data)
}
