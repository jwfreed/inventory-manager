import type { ApiError } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

function buildUrl(path: string) {
  if (path.startsWith('http')) return path
  const base = API_BASE_URL || ''
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}

async function handleResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: any = null

  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (response.ok) {
    return parsed as T
  }

  const error: ApiError = {
    status: response.status,
    message: (parsed && (parsed.message || parsed.error)) || response.statusText,
    details: parsed?.details ?? parsed,
  }
  throw error
}

type RequestOptions = RequestInit & {
  params?: Record<string, string | number | boolean | undefined>
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(buildUrl(path))
  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.append(key, String(value))
    })
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  return handleResponse<T>(response)
}

export const apiGet = <T>(path: string, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'GET' })

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) })

export const apiPut = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) })

export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  request<T>(path, { ...options, method: 'DELETE' })
