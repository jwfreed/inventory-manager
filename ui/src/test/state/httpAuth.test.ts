import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '../../api/http'
import { clearAuthSession, getAuthState, setAuthenticatedSession } from '../../lib/authStore'

const session = {
  accessToken: 'fresh-token',
  user: { id: 'user-1', email: 'jon.freed@gmail.com' },
  tenant: { id: 'tenant-1', name: 'SIAMAYA', slug: 'siamaya' },
  role: 'admin',
} as const

describe('http auth coordination', () => {
  function readAuthorization(init?: RequestInit) {
    if (!init?.headers) return ''
    if (init.headers instanceof Headers) {
      return init.headers.get('Authorization') ?? init.headers.get('authorization') ?? ''
    }
    if (Array.isArray(init.headers)) {
      const pair = init.headers.find(([key]) => key.toLowerCase() === 'authorization')
      return pair?.[1] ?? ''
    }
    const headers = init.headers as Record<string, string | undefined>
    return String(headers.Authorization ?? headers.authorization ?? '')
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    clearAuthSession('manual', { broadcast: false })
  })

  it('deduplicates refresh attempts across concurrent 401 responses', async () => {
    setAuthenticatedSession({ ...session, accessToken: 'stale-token' }, { broadcast: false })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const authHeader = readAuthorization(init)
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (authHeader === 'Bearer stale-token') {
        return new Response(JSON.stringify({ error: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ data: ['ok'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    const [first, second] = await Promise.all([
      apiGet<{ data: string[] }>('/items'),
      apiGet<{ data: string[] }>('/items'),
    ])

    expect(first.data).toEqual(['ok'])
    expect(second.data).toEqual(['ok'])
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1)
    expect(getAuthState().status).toBe('authenticated')
    expect(getAuthState().accessToken).toBe('fresh-token')
  })

  it('logs the user out when refresh fails', async () => {
    setAuthenticatedSession({ ...session, accessToken: 'stale-token' }, { broadcast: false })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ error: 'invalid refresh token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'expired access token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 401 })
    expect(getAuthState().status).toBe('unauthenticated')
    expect(getAuthState().logoutReason).toBe('refresh-failed')
    expect(getAuthState().accessToken).toBeNull()
  })

  it('logs the user out when refresh fails with 403 (untrusted origin)', async () => {
    setAuthenticatedSession({ ...session, accessToken: 'stale-token' }, { broadcast: false })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ error: 'Untrusted origin.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'expired access token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 401 })
    expect(getAuthState().status).toBe('unauthenticated')
    expect(getAuthState().logoutReason).toBe('refresh-failed')
    expect(getAuthState().accessToken).toBeNull()
  })

  it('retries the original request exactly once after successful refresh', async () => {
    setAuthenticatedSession({ ...session, accessToken: 'stale-token' }, { broadcast: false })

    let apiCallCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const authHeader = readAuthorization(init)

      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      apiCallCount++
      if (authHeader === 'Bearer stale-token') {
        return new Response(JSON.stringify({ error: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await apiGet<{ result: string }>('/items')
    expect(result.result).toBe('ok')
    // original call (401) + one retry (200) = 2 calls to /items
    expect(apiCallCount).toBe(2)
    // refresh called exactly once
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1)
    expect(getAuthState().status).toBe('authenticated')
    expect(getAuthState().accessToken).toBe('fresh-token')
  })
})
