import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import type { ApiError } from '../api/types'
import { apiGet, apiPost, refreshAccessToken } from '../api/http'
import {
  clearAuthSession,
  getAccessToken,
  getAuthState,
  setAuthenticatedProfile,
  setAuthenticatedSession,
  subscribeAuthState,
} from './authStore'
import { LoadingSpinner } from '../components/Loading'
import type {
  AuthContextValue,
  AuthSession,
  AuthTenant,
  AuthUser,
  BootstrapInput,
  LoginInput,
} from './authContext'
import { AuthContext } from './authContext'
import { useAuth } from './useAuth'
import { hasAllUiPermissions, hasAnyUiPermission, hasUiPermission, type Permission } from './permissions'

function isAuthError(error: unknown) {
  const apiError = error as ApiError | undefined
  return apiError?.status === 401 || apiError?.status === 403
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeAuthState, getAuthState, getAuthState)

  const hydrateFromMe = useCallback(
    (payload: { user: AuthUser; tenant: AuthTenant; role?: string; permissions?: string[] }) => {
      const token = getAccessToken()
      if (!token) {
        clearAuthSession('unknown')
        return
      }
      setAuthenticatedProfile(payload, { accessToken: token })
    },
    [],
  )

  const refresh = useCallback(async () => {
    const session = await refreshAccessToken()
    if (session?.accessToken && session.user && session.tenant) {
      setAuthenticatedSession(session as AuthSession)
      return
    }
    if (session?.accessToken) {
      const me = await apiGet<{ user: AuthUser; tenant: AuthTenant; role?: string; permissions?: string[] }>('/auth/me', {
        skipAuthRefresh: true,
      })
      hydrateFromMe(me)
      return
    }
    clearAuthSession('refresh-failed')
  }, [hydrateFromMe])

  useEffect(() => {
    if (state.status !== 'loading') return

    let active = true
    const init = async () => {
      const token = getAccessToken()
      if (token) {
        try {
          const me = await apiGet<{ user: AuthUser; tenant: AuthTenant; role?: string; permissions?: string[] }>('/auth/me', {
            skipAuthRefresh: true,
          })
          if (!active) return
          // broadcast: false — bootstrap must not re-broadcast to other tabs; the original
          // sign-in event already notified them. Re-broadcasting here creates a cross-tab
          // ping-pong where each tab's bootstrap triggers the other's, causing an infinite
          // /auth/me loop.
          setAuthenticatedProfile(me, { accessToken: token, broadcast: false })
          return
        } catch (error) {
          if (!active) return
          if (!isAuthError(error)) {
            clearAuthSession('unknown')
            return
          }
        }
      }

      try {
        const session = await refreshAccessToken()
        if (!active) return
        if (session?.accessToken && session.user && session.tenant) {
          setAuthenticatedSession(session as AuthSession, { broadcast: false })
          return
        }
        if (session?.accessToken) {
          const me = await apiGet<{ user: AuthUser; tenant: AuthTenant; role?: string; permissions?: string[] }>('/auth/me', {
            skipAuthRefresh: true,
          })
          if (!active) return
          setAuthenticatedProfile(me, { accessToken: session.accessToken, broadcast: false })
          return
        }
        clearAuthSession('refresh-failed')
      } catch {
        if (!active) return
        clearAuthSession('refresh-failed')
      }
    }

    void init()
    return () => {
      active = false
    }
  }, [state.status])

  const login = useCallback(async (input: LoginInput) => {
    const session = await apiPost<AuthSession>('/auth/login', input)
    setAuthenticatedSession(session)
  }, [])

  const bootstrap = useCallback(async (input: BootstrapInput) => {
    const session = await apiPost<AuthSession>('/auth/bootstrap', input)
    setAuthenticatedSession(session)
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiPost('/auth/logout')
    } finally {
      clearAuthSession('manual')
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      bootstrap,
      logout,
      refresh,
      hasPermission: (permission: string) => hasUiPermission(state.permissions, permission),
      hasAnyPermission: (permissions: readonly string[]) => hasAnyUiPermission(state.permissions, permissions),
      hasAllPermissions: (permissions: readonly string[]) => hasAllUiPermissions(state.permissions, permissions),
    }),
    [bootstrap, login, logout, refresh, state],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, logoutReason } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-25">
        <LoadingSpinner label="Loading session..." />
      </div>
    )
  }
  if (status !== 'authenticated') {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          from: `${location.pathname}${location.search}${location.hash}`,
          reason: logoutReason,
        }}
      />
    )
  }
  return <>{children}</>
}

export function RequirePermission({ children, permission }: { children: ReactNode; permission: Permission }) {
  const { permissions } = useAuth()

  if (!hasUiPermission(permissions, permission)) {
    return <Navigate to="/not-found" replace />
  }

  return <>{children}</>
}
