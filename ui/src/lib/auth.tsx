import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { apiGet, apiPost, refreshAccessToken } from '../api/http'
import { getAccessToken, setAccessToken } from './authStore'
import { LoadingSpinner } from '../components/Loading'
import type {
  AuthContextValue,
  AuthSession,
  AuthState,
  AuthTenant,
  AuthUser,
  BootstrapInput,
  LoginInput,
} from './authContext'
import { AuthContext } from './authContext'
import { useAuth } from './useAuth'

function mapSession(session: AuthSession): AuthState {
  return {
    status: 'authenticated',
    accessToken: session.accessToken,
    user: session.user,
    tenant: session.tenant,
    role: session.role ?? null,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({
    status: 'loading',
    accessToken: getAccessToken(),
    user: null,
    tenant: null,
    role: null,
  }))

  const hydrateFromSession = useCallback((session: AuthSession) => {
    setAccessToken(session.accessToken)
    setState(mapSession(session))
  }, [])

  const hydrateFromMe = useCallback(
    (payload: { user: AuthUser; tenant: AuthTenant; role?: string }) => {
      const token = getAccessToken()
      if (!token) {
        setState({
          status: 'unauthenticated',
          accessToken: null,
          user: null,
          tenant: null,
          role: null,
        })
        return
      }
      setState({
        status: 'authenticated',
        accessToken: token,
        user: payload.user,
        tenant: payload.tenant,
        role: payload.role ?? null,
      })
    },
    [],
  )

  const refresh = useCallback(async () => {
    const session = await refreshAccessToken()
    if (session?.accessToken && session.user && session.tenant) {
      hydrateFromSession(session as AuthSession)
      return
    }
    if (session?.accessToken) {
      const me = await apiGet<{ user: AuthUser; tenant: AuthTenant; role?: string }>('/auth/me')
      hydrateFromMe(me)
      return
    }
    setAccessToken(null)
    setState({
      status: 'unauthenticated',
      accessToken: null,
      user: null,
      tenant: null,
      role: null,
    })
  }, [hydrateFromMe, hydrateFromSession])

  useEffect(() => {
    let active = true
    const init = async () => {
      const token = getAccessToken()
      if (token) {
        try {
          const me = await apiGet<{ user: AuthUser; tenant: AuthTenant; role?: string }>('/auth/me')
          if (!active) return
          hydrateFromMe(me)
          return
        } catch {
          // fall through to refresh
        }
      }

      try {
        await refresh()
      } catch {
        if (!active) return
        setAccessToken(null)
        setState({
          status: 'unauthenticated',
          accessToken: null,
          user: null,
          tenant: null,
          role: null,
        })
      }
    }

    void init()
    return () => {
      active = false
    }
  }, [hydrateFromMe, refresh])

  const login = useCallback(
    async (input: LoginInput) => {
      const session = await apiPost<AuthSession>('/auth/login', input)
      hydrateFromSession(session)
    },
    [hydrateFromSession],
  )

  const bootstrap = useCallback(
    async (input: BootstrapInput) => {
      const session = await apiPost<AuthSession>('/auth/bootstrap', input)
      hydrateFromSession(session)
    },
    [hydrateFromSession],
  )

  const logout = useCallback(async () => {
    try {
      await apiPost('/auth/logout')
    } finally {
      setAccessToken(null)
      setState({
        status: 'unauthenticated',
        accessToken: null,
        user: null,
        tenant: null,
        role: null,
      })
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      bootstrap,
      logout,
      refresh,
    }),
    [state, login, bootstrap, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-25">
        <LoadingSpinner label="Loading session..." />
      </div>
    )
  }
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
