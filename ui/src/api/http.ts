import type { ApiError } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

function buildUrl(path: string) {
  if (path.startsWith('http')) return path

  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  // If no explicit base URL is provided, prefer calling via Vite proxy at /api/*.
  if (!API_BASE_URL) {
    return normalizedPath.startsWith('/api') ? normalizedPath : `/api${normalizedPath}`
  }

  const normalizedBase = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL
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

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    })
  } catch (err) {
    const error: ApiError = {
      status: 0,
      message: 'Network error while contacting API',
      details: err,
    }
    throw error
  }

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
