import type { AuthSession, AuthState, AuthTenant, AuthUser } from './authContext'

const TOKEN_KEY = 'inventory.accessToken'
const AUTH_EVENT_KEY = 'inventory.auth.event'
const AUTH_CHANNEL_NAME = 'inventory.auth'

type LogoutReason = AuthState['logoutReason']
type AuthSyncEvent =
  | { type: 'signed-in'; issuedAt: number }
  | { type: 'signed-out'; issuedAt: number; reason: LogoutReason }

type AuthProfilePayload = {
  user: AuthUser
  tenant: AuthTenant
  role?: string | null
  permissions?: string[]
}

type AuthStateListener = (state: AuthState) => void
type AccessTokenListener = (token: string | null) => void

let accessToken: string | null = null
let channel: BroadcastChannel | null = null
let browserBindingsReady = false

let state: AuthState = {
  status: 'loading',
  accessToken: null,
  user: null,
  tenant: null,
  role: null,
  permissions: [],
  logoutReason: null,
}

const stateListeners = new Set<AuthStateListener>()
const accessTokenListeners = new Set<AccessTokenListener>()

function readStoredToken() {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

function writeStoredToken(token: string | null) {
  accessToken = token
  if (typeof window !== 'undefined') {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token)
    } else {
      window.localStorage.removeItem(TOKEN_KEY)
    }
  }
}

function notify(nextState: AuthState) {
  state = nextState
  stateListeners.forEach((listener) => listener(state))
  accessTokenListeners.forEach((listener) => listener(state.accessToken))
}

function broadcast(event: AuthSyncEvent) {
  if (typeof window === 'undefined') return
  const payload = JSON.stringify(event)
  window.localStorage.setItem(AUTH_EVENT_KEY, payload)
  if ('BroadcastChannel' in window) {
    channel ??= new window.BroadcastChannel(AUTH_CHANNEL_NAME)
    channel.postMessage(event)
  }
}

function applySignedInFromSync() {
  const token = readStoredToken()
  accessToken = token
  notify({
    status: token ? 'loading' : 'unauthenticated',
    accessToken: token,
    user: token ? state.user : null,
    tenant: token ? state.tenant : null,
    role: token ? state.role : null,
    permissions: token ? state.permissions : [],
    logoutReason: null,
  })
}

function applySignedOutFromSync(reason: LogoutReason) {
  accessToken = null
  notify({
    status: 'unauthenticated',
    accessToken: null,
    user: null,
    tenant: null,
    role: null,
    permissions: [],
    logoutReason: reason ?? 'unknown',
  })
}

function handleSyncEvent(event: AuthSyncEvent) {
  if (event.type === 'signed-in') {
    applySignedInFromSync()
    return
  }
  applySignedOutFromSync(event.reason ?? 'remote-signout')
}

function ensureBrowserBindings() {
  if (browserBindingsReady || typeof window === 'undefined') return
  browserBindingsReady = true
  accessToken = readStoredToken()
  state = {
    ...state,
    accessToken,
  }

  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY) {
      if (event.newValue) {
        applySignedInFromSync()
      } else {
        applySignedOutFromSync('remote-signout')
      }
      return
    }

    if (event.key !== AUTH_EVENT_KEY || !event.newValue) return
    try {
      handleSyncEvent(JSON.parse(event.newValue) as AuthSyncEvent)
    } catch {
      // Ignore malformed sync messages from older clients.
    }
  })

  if ('BroadcastChannel' in window) {
    channel = new window.BroadcastChannel(AUTH_CHANNEL_NAME)
    channel.addEventListener('message', (message) => {
      const data = message.data
      if (!data || typeof data !== 'object' || !('type' in data)) return
      handleSyncEvent(data as AuthSyncEvent)
    })
  }
}

export function getAccessToken() {
  ensureBrowserBindings()
  if (accessToken === null) {
    accessToken = readStoredToken()
  }
  return accessToken
}

export function getAuthState() {
  ensureBrowserBindings()
  return state
}

export function setAuthLoading() {
  ensureBrowserBindings()
  const token = getAccessToken()
  notify({
    status: 'loading',
    accessToken: token,
    user: token ? state.user : null,
    tenant: token ? state.tenant : null,
    role: token ? state.role : null,
    permissions: token ? state.permissions : [],
    logoutReason: null,
  })
}

export function setAuthenticatedSession(session: AuthSession, options?: { broadcast?: boolean }) {
  ensureBrowserBindings()
  writeStoredToken(session.accessToken)
  notify({
    status: 'authenticated',
    accessToken: session.accessToken,
    user: session.user,
    tenant: session.tenant,
    role: session.role ?? null,
    permissions: session.permissions ?? [],
    logoutReason: null,
  })
  if (options?.broadcast !== false) {
    broadcast({ type: 'signed-in', issuedAt: Date.now() })
  }
}

export function setAuthenticatedProfile(
  payload: AuthProfilePayload,
  options?: { accessToken?: string | null; broadcast?: boolean }
) {
  ensureBrowserBindings()
  const token = options?.accessToken ?? getAccessToken()
  if (token) {
    writeStoredToken(token)
  }
  notify({
    status: token ? 'authenticated' : 'unauthenticated',
    accessToken: token,
    user: token ? payload.user : null,
    tenant: token ? payload.tenant : null,
    role: token ? payload.role ?? null : null,
    permissions: token ? payload.permissions ?? [] : [],
    logoutReason: null,
  })
  if (token && options?.broadcast !== false) {
    broadcast({ type: 'signed-in', issuedAt: Date.now() })
  }
}

export function clearAuthSession(reason: LogoutReason = 'unknown', options?: { broadcast?: boolean }) {
  ensureBrowserBindings()
  writeStoredToken(null)
  notify({
    status: 'unauthenticated',
    accessToken: null,
    user: null,
    tenant: null,
    role: null,
    permissions: [],
    logoutReason: reason,
  })
  if (options?.broadcast !== false) {
    broadcast({ type: 'signed-out', issuedAt: Date.now(), reason })
  }
}

export function subscribeAuthState(listener: AuthStateListener) {
  ensureBrowserBindings()
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function setAccessToken(token: string | null) {
  ensureBrowserBindings()
  if (!token) {
    clearAuthSession('unknown')
    return
  }
  writeStoredToken(token)
  notify({
    ...state,
    accessToken: token,
    logoutReason: null,
  })
}

export function onAccessTokenChange(listener: AccessTokenListener) {
  ensureBrowserBindings()
  accessTokenListeners.add(listener)
  return () => accessTokenListeners.delete(listener)
}
