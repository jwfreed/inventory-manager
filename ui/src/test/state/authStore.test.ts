import { beforeEach, describe, expect, it } from 'vitest'
import { clearAuthSession, getAuthState, setAuthenticatedProfile, setAuthenticatedSession } from '../../lib/authStore'

describe('authStore', () => {
  beforeEach(() => {
    localStorage.clear()
    clearAuthSession('manual', { broadcast: false })
  })

  it('tracks authenticated sessions in the canonical store', () => {
    setAuthenticatedSession(
      {
        accessToken: 'token-1',
        user: { id: 'user-1', email: 'jon.freed@gmail.com' },
        tenant: { id: 'tenant-1', name: 'SIAMAYA', slug: 'siamaya' },
        role: 'admin',
      },
      { broadcast: false },
    )

    expect(getAuthState()).toMatchObject({
      status: 'authenticated',
      accessToken: 'token-1',
      role: 'admin',
      logoutReason: null,
    })
    expect(localStorage.getItem('inventory.accessToken')).toBe('token-1')
  })

  it('records logout reason when auth is cleared', () => {
    setAuthenticatedProfile(
      {
        user: { id: 'user-1', email: 'jon.freed@gmail.com' },
        tenant: { id: 'tenant-1', name: 'SIAMAYA', slug: 'siamaya' },
        role: 'admin',
      },
      { accessToken: 'token-2', broadcast: false },
    )

    clearAuthSession('refresh-failed', { broadcast: false })

    expect(getAuthState()).toMatchObject({
      status: 'unauthenticated',
      accessToken: null,
      user: null,
      tenant: null,
      role: null,
      logoutReason: 'refresh-failed',
    })
    expect(localStorage.getItem('inventory.accessToken')).toBeNull()
  })
})
