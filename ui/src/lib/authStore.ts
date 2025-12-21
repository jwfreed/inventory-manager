const TOKEN_KEY = 'inventory.accessToken'

let accessToken: string | null = null
const listeners = new Set<(token: string | null) => void>()

export function getAccessToken() {
  if (accessToken === null && typeof window !== 'undefined') {
    accessToken = window.localStorage.getItem(TOKEN_KEY)
  }
  return accessToken
}

export function setAccessToken(token: string | null) {
  accessToken = token
  if (typeof window !== 'undefined') {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token)
    } else {
      window.localStorage.removeItem(TOKEN_KEY)
    }
  }
  listeners.forEach((listener) => listener(token))
}

export function onAccessTokenChange(listener: (token: string | null) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
