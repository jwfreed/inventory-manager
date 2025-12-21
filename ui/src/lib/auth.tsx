import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { apiGet, apiPost, refreshAccessToken } from '../api/http'
import { getAccessToken, setAccessToken } from './authStore'
import { LoadingSpinner } from '../components/Loading'

type AuthUser = {
  id: string
  email: string
  fullName?: string | null
  active?: boolean
  createdAt?: string
  updatedAt?: string
}

type AuthTenant = {
  id: string
  name: string
  slug: string
  parentTenantId?: string | null
  createdAt?: string
}

type AuthSession = {
  accessToken: string
  user: AuthUser
  tenant: AuthTenant
  role?: string
}

type AuthState = {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  accessToken: string | null
  user: AuthUser | null
  tenant: AuthTenant | null
  role: string | null
}

type LoginInput = {
  email: string
  password: string
  tenantId?: string
  tenantSlug?: string
}

type BootstrapInput = {
  tenantName?: string
  tenantSlug?: string
  adminEmail: string
  adminPassword: string
  adminName?: string
}

type AuthContextValue = AuthState & {
  login: (input: LoginInput) => Promise<void>
  bootstrap: (input: BootstrapInput) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

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

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
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
