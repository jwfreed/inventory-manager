import type { ApiError } from './types'
import { buildUrl } from './baseUrl'
import { getAccessToken, setAccessToken } from '../lib/authStore'

export type AuthSession = {
  accessToken: string
  user?: unknown
  tenant?: unknown
  role?: unknown
}

async function handleResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown = null

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
  skipAuthRefresh?: boolean
}

let refreshPromise: Promise<AuthSession | null> | null = null

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const response = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      })

      if (!response.ok) {
        if (response.status === 401) {
          setAccessToken(null)
        }
        return null
      }

      const session = (await response.json()) as AuthSession
      if (session?.accessToken) {
        setAccessToken(session.accessToken)
      }
      return session
    } catch {
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(buildUrl(path))
  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.append(key, String(value))
    })
  }

  const accessToken = getAccessToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(options.headers || {}),
  }

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers,
      credentials: 'include',
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

  const authPath = url.pathname.startsWith('/api') ? url.pathname.slice(4) : url.pathname
  if (response.status === 401 && !options.skipAuthRefresh && !authPath.startsWith('/auth')) {
    const refreshed = await refreshAccessToken()
    if (refreshed?.accessToken) {
      const retryHeaders = {
        ...headers,
        Authorization: `Bearer ${refreshed.accessToken}`,
      }
      response = await fetch(url.toString(), {
        headers: retryHeaders,
        credentials: 'include',
        ...options,
      })
    }
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
