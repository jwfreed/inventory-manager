import { createContext } from 'react'

export type AuthUser = {
  id: string
  email: string
  fullName?: string | null
  active?: boolean
  createdAt?: string
  updatedAt?: string
}

export type AuthTenant = {
  id: string
  name: string
  slug: string
  parentTenantId?: string | null
  createdAt?: string
}

export type AuthSession = {
  accessToken: string
  user: AuthUser
  tenant: AuthTenant
  role?: string
}

export type AuthState = {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  accessToken: string | null
  user: AuthUser | null
  tenant: AuthTenant | null
  role: string | null
}

export type LoginInput = {
  email: string
  password: string
  tenantId?: string
  tenantSlug?: string
}

export type BootstrapInput = {
  tenantName?: string
  tenantSlug?: string
  adminEmail: string
  adminPassword: string
  adminName?: string
}

export type AuthContextValue = AuthState & {
  login: (input: LoginInput) => Promise<void>
  bootstrap: (input: BootstrapInput) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
