import { apiGet } from '../../http'
import type { ApiError, ReturnDoc } from '../../types'

type ListResponse = { data: ReturnDoc[]; notImplemented?: boolean }

export async function listReturns(): Promise<ListResponse> {
  try {
    const res = await apiGet<ReturnDoc[] | { data?: ReturnDoc[] }>('/returns')
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getReturn(id: string): Promise<ReturnDoc & { notImplemented?: boolean }> {
  try {
    return await apiGet<ReturnDoc>(`/returns/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}
