import { apiGet } from '../../http'
import type { ApiError, ReturnDoc } from '../../types'
import { ORDER_TO_CASH_ENDPOINTS } from './config'

type ListResponse = { data: ReturnDoc[]; notImplemented?: boolean }

export async function listReturns(): Promise<ListResponse> {
  if (!ORDER_TO_CASH_ENDPOINTS.returns) {
    return { data: [], notImplemented: true }
  }

  try {
    const res = await apiGet<ReturnDoc[] | { data?: ReturnDoc[] }>(
      ORDER_TO_CASH_ENDPOINTS.returns,
    )
    if (Array.isArray(res)) return { data: res }
    return { data: res.data ?? [] }
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) return { data: [], notImplemented: true }
    throw err
  }
}

export async function getReturn(id: string): Promise<ReturnDoc & { notImplemented?: boolean }> {
  if (!ORDER_TO_CASH_ENDPOINTS.returns) {
    return { id, notImplemented: true }
  }

  try {
    return await apiGet<ReturnDoc>(`${ORDER_TO_CASH_ENDPOINTS.returns}/${id}`)
  } catch (error) {
    const err = error as ApiError
    if (err.status === 404) {
      return { id, notImplemented: true }
    }
    throw err
  }
}
